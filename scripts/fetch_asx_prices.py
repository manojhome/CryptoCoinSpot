import csv,datetime as dt,json,time,urllib.request,urllib.error,concurrent.futures
from pathlib import Path
from zoneinfo import ZoneInfo
# Run with --source <company list or existing yearly CSV> --output <destination CSV>.
import argparse
parser=argparse.ArgumentParser(description='Fetch ASX yearly closing prices from Yahoo Finance.')
parser.add_argument('--source', type=Path, default=Path('ASXListedCompanies.csv'))
parser.add_argument('--output', type=Path, default=Path('ASX_Yearly_Prices_2022_2026.csv'))
args=parser.parse_args()
START_YEAR,END_YEAR=2022,2026
start=int(dt.datetime(START_YEAR,1,1,tzinfo=dt.timezone.utc).timestamp())
end=int(dt.datetime(END_YEAR+1,1,1,tzinfo=dt.timezone.utc).timestamp())
source=args.source; output=args.output
with source.open(encoding='utf-8-sig',newline='') as f:
    # ASX directory exports have two introductory lines; yearly CSVs do not.
    first=f.readline()
    if first.startswith('Company name,'):f.seek(0)
    else:next(f)
    companies=list(csv.DictReader(f))
def fetch(company):
    code=company['ASX code'].strip(); ticker=code+'.AX'
    row={'Company name':company['Company name'],'ASX code':code,'GICS industry group':company['GICS industry group']}
    for y in range(START_YEAR,END_YEAR+1):
        for field in ('First Trading Date','Start Price AUD','Last Trading Date','End Price AUD','Annual Change %'):
            row[f'{y} {field}']=''
    row['Status']='No price data'
    url=f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?period1={start}&period2={end}&interval=1d'
    for attempt in range(3):
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
            with urllib.request.urlopen(req,timeout=25) as response: payload=json.load(response)
            result=payload['chart']['result'][0]
            stamps=result.get('timestamp',[])
            closes=result['indicators']['quote'][0].get('close',[])
            grouped={}
            for stamp,close in zip(stamps,closes):
                if close is None:continue
                date=dt.datetime.fromtimestamp(stamp,ZoneInfo('Australia/Sydney')).date()
                if START_YEAR<=date.year<=END_YEAR:grouped.setdefault(date.year,[]).append((date,float(close)))
            for year,values in grouped.items():
                values.sort();first,last=values[0],values[-1]
                row[f'{year} First Trading Date']=first[0].isoformat()
                row[f'{year} Start Price AUD']=f'{first[1]:.4f}'
                row[f'{year} Last Trading Date']=last[0].isoformat()
                row[f'{year} End Price AUD']=f'{last[1]:.4f}'
                if first[1]:row[f'{year} Annual Change %']=f'{(last[1]/first[1]-1)*100:.2f}'
            row['Status']='OK' if grouped else 'No price data'
            return row
        except urllib.error.HTTPError as exc:
            row['Status']=f'HTTP {exc.code}'
            if exc.code in (404,400):break
        except Exception as exc:row['Status']=f'{type(exc).__name__}: {str(exc)[:90]}'
        time.sleep(1.5*(attempt+1))
    return row
fields=['Company name','ASX code','GICS industry group']+[f'{y} {field}' for y in range(START_YEAR,END_YEAR+1) for field in ('First Trading Date','Start Price AUD','Last Trading Date','End Price AUD','Annual Change %')]+['Status']
with output.open('w',newline='',encoding='utf-8-sig') as f:
    writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader()
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        for i,row in enumerate(pool.map(fetch,companies),1):
            writer.writerow(row)
            if i%100==0:print(f'{i}/{len(companies)} completed',flush=True)
print('Saved',output)
