// 腾讯可比估值（fetch-comps.js 自动生成，勿手改；2026-10-23 方案固化）
// 对标 Google40%/Meta30%/微软30%（业务重合度权重）；腾讯 EPS=现价/PE-TTM 反推；
// fair = EPS×加权PE×(1−折价) 三档（0/10%/20%）；buys 以 10% 折价为基准 ×50%/60%/70%；盘中实时联动见 app.js applyLive
window.COMPS = {
 "asOf": "2026-10-27",
 "target": {
  "code": "hk00700",
  "name": "腾讯控股",
  "px": 385.2,
  "pe": 12.92,
  "peTTM": true,
  "epsTTM": 29.81
 },
 "fx": {
  "usdHkd": 7.843,
  "asOf": ""
 },
 "items": [
  {
   "key": "goog",
   "code": "usGOOG",
   "name": "Google",
   "w": 0.4,
   "px": 316.61,
   "pe": 15.89,
   "why": "业务结构最像：广告+云+AI平台，同受反垄断监管"
  },
  {
   "key": "meta",
   "code": "usMETA",
   "name": "Meta",
   "w": 0.3,
   "px": 624.56,
   "pe": 21.31,
   "why": "社交广告变现对标（微信生态 vs 社交矩阵）"
  },
  {
   "key": "msft",
   "code": "usMSFT",
   "name": "微软",
   "w": 0.3,
   "px": 532.92,
   "pe": 29.69,
   "why": "云+企业服务对标（腾讯云/AI），业务重合度最低"
  }
 ],
 "wpe": 21.66,
 "discounts": [
  0,
  0.1,
  0.2
 ],
 "fair": {
  "none": 645.7,
  "d10": 581.1,
  "d20": 516.5
 },
 "buys": {
  "ideal": 290.6,
  "tier2": 348.7,
  "tier3": 406.8
 },
 "buyMults": [
  0.5,
  0.6,
  0.7
 ],
 "baseDisc": 0.1
};
