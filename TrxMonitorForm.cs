using System.Globalization;
using Microsoft.VisualBasic;

namespace CryptoTrader;

public sealed class TrxMonitorForm : Form
{
    private readonly MarketDataClient _market;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 60 * 60 * 1000 };
    private readonly Label _value = MakeLabel(22, FontStyle.Bold);
    private readonly Label _signal = MakeLabel(16, FontStyle.Bold);
    private readonly Label _details = MakeLabel(11, FontStyle.Regular);
    private readonly Label _updated = MakeLabel(9, FontStyle.Italic);
    private readonly Button _refresh = new() { Text = "Refresh now", AutoSize = true };
    private decimal _investmentAud;
    private decimal _entryPrice;
    private decimal _units;
    private bool _refreshing;

    public TrxMonitorForm(MarketDataClient market)
    {
        _market = market;
        Text = "CryptoCoinSpot — TRX Paper Investment Monitor";
        Width = 760;
        Height = 480;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;

        var input = Interaction.InputBox(
            "Enter the AUD amount to track. This is a paper monitor and will not place a CoinSpot order.",
            "TRX investment amount", "1000");
        if (!decimal.TryParse(input, NumberStyles.Number, CultureInfo.CurrentCulture, out _investmentAud) ||
            _investmentAud <= 0)
        {
            Shown += (_, _) => Close();
            return;
        }

        var heading = MakeLabel(13, FontStyle.Bold);
        heading.Text = $"Tracking A${_investmentAud:N2} as a hypothetical TRX investment";
        _details.MaximumSize = new Size(700, 0);
        _details.AutoSize = true;
        _refresh.Click += async (_, _) => await RefreshAsync();
        _timer.Tick += async (_, _) => await RefreshAsync();

        var panel = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Padding = new Padding(22),
            AutoScroll = true
        };
        panel.Controls.Add(heading);
        panel.Controls.Add(_value);
        panel.Controls.Add(_signal);
        panel.Controls.Add(_details);
        panel.Controls.Add(_updated);
        panel.Controls.Add(_refresh);
        Controls.Add(panel);

        Shown += async (_, _) =>
        {
            await RefreshAsync();
            _timer.Start();
        };
    }

    private async Task RefreshAsync()
    {
        if (_refreshing) return;
        _refreshing = true;
        _refresh.Enabled = false;
        _updated.Text = "Updating…";
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
            var hourly = await _market.GetHourlyAsync("TRX", 4, "aud", timeout.Token);
            await Task.Delay(TimeSpan.FromSeconds(3), timeout.Token);
            var daily = await _market.GetRecentDailyAsync("TRX", 45, "aud", timeout.Token);
            var current = hourly[^1].Close;
            if (_entryPrice == 0)
            {
                _entryPrice = current;
                _units = _investmentAud / current;
            }

            var strategy = TrxStrategy.Evaluate(daily);
            var currentValue = _units * current;
            var profit = currentValue - _investmentAud;
            var percent = profit / _investmentAud * 100;
            var exit = TrxStrategy.EvaluateExit(_entryPrice, current, strategy.Support, daily);

            _value.Text = $"A${currentValue:N2}   ({percent:+0.00;-0.00;0.00}%)";
            _value.ForeColor = profit >= 0 ? Color.ForestGreen : Color.Firebrick;
            _signal.Text = $"{strategy.Action} · {exit}";
            _signal.ForeColor = strategy.Action == "BUY SETUP" ? Color.ForestGreen :
                exit.StartsWith("EXIT", StringComparison.Ordinal) ? Color.Firebrick : Color.DarkOrange;
            _details.Text =
                $"TRX price: A${current:N6}   Entry snapshot: A${_entryPrice:N6}   Units: {_units:N4}\n" +
                $"MA20: A${strategy.MovingAverage20:N6}   Support: A${strategy.Support:N3}   " +
                $"Pullback red days: {strategy.PullbackRedDays}\n\n{strategy.Explanation}\n\n" +
                "Signals are informational. This window never places an order.";
            _updated.Text = $"Updated {DateTimeOffset.Now:g}; next automatic update in one hour.";
        }
        catch (Exception ex)
        {
            _updated.Text = $"Update failed: {ex.Message} — use Refresh now to retry.";
        }
        finally
        {
            _refresh.Enabled = true;
            _refreshing = false;
        }
    }

    private static Label MakeLabel(float size, FontStyle style) =>
        new() { AutoSize = true, Font = new Font("Segoe UI", size, style), Margin = new Padding(3, 8, 3, 8) };
}
