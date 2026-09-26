# TrustCom (trustcom.vip) — Reverse-Engineered Page Spec

Source bundle: `trustcom-app.js` (Vue 3 + webpack, main module `4253`).
Reference: `helpers/out/module_4253_pretty.js` (all line numbers below).
i18n: `helpers/out/dict_en.txt` (EN copy quoted verbatim).

Line references are to the beautified module. `data-v-*` = Vue `__scopeId`.

---

## 0. Global wiring

- Vue 3, vue-router 4, Element Plus partially (e.g. `n.g2("Toast")` / `AppToast`), lightweight-charts for kline.
- App bootstrap reads `window.AppConfig` knobs:
  - `appTitle` (|| "Trust"), `logoPath`, `metalTabFirst`, `advancedAuthEnabled`, `aiQuantEnabled`,
    `walletLoginEnabled`, `disablePasswordLogin`, `showMinOrderAmount`,
    `disableWeekendTradingForNonCrypto` (default `true`), `apiBaseUrl`, `defaultLanguage`,
    `withdrawalFeeRate`, `showCountdownCurrentStatus`, `btc`/`eth`/`usdt`/`usdc` (deposit addresses),
    `customerServiceUrl`.
- Locale: `window.AppConfig?.defaultLanguage` else localStorage `selectedLanguage` / `preferred_language`; `fallbackLocale: "en"`. 21 locale dicts.
- HTTP: axios with `credentials: "include"`; token-based auth (`GET .../token.html` → `POST`).
- Image URL helper `getImageUrl(x)`: if starts with `http` return as-is, else prefix `AppConfig.apiBaseUrl` (e.g. `/bi/usdt.png`, `/api/...`).

---

## 1. TradePage / MarketDetail  (`/market/:pid`)

Component `Er` @3610 (name `MarketDetail`), render `br` @3273, scopeId `data-v-76b0c66a`.
Fallback durations `Sr` (no API data): `[{id:"fallback-60",second:60,odds:1.8,min_amount:10}, {id:"fallback-120",second:120,odds:1.9,min_amount:10}, {id:"fallback-300",second:300,odds:2.1,min_amount:10}]`.
Fallback wallets `Nr`: `[{id:"wallet-usdt",coin:"USDT",balance:"0.00"}, {id:"wallet-btc",coin:"BTC",balance:"0.00"}]`.
Asset map `Ir`: `record`=`img/icon_pro_record.e0ae5e13.d6b2f78f.svg`, `time`=`img/icon_time.20dd9c20.9a6f791d.svg`, `arrow`=`img/icon_arrow_down.fca20a50.c7fd74d0.svg`, `up`=`img/green_up.19f36634.02d57a4a.svg`, `down`=`img/red_down.82c00110.a0954a09.svg`, `collect`=inline data-PNG, `collectActive`=`img/icon_pro_collect.bf32e20c.b24f05d9.svg`.

### Page shell
```
div > header (.back-btn [left chevron svg M15 18l-6-6 6-6, currentColor], div= info.coin||"--", div.header-placeholder)
    section.price-header
    section (icon-btn img record -> /orders)
    section.kline-section
       .time-item 1M/5M/15M/30M/1H/1D   (interval keys "1","5","15","30","60","d"; active class toggles)
       .kline-container (lightweight-charts: bg #fff, text #333, grid #e0e0e0, MA #ff9800/#3f51b5/#4caf50/#9c27b0, precision 4)
       .price-display: Time/Open/High/Low/Close/Volume rows, labels trade.time/trade.open/trade.high/trade.low/trade.close/trade.volume, values "--"
    button.submit-btn  = isTradingAllowed ? trade.startTrading : tradingDisabledMessage  (disabled=!isTradingAllowed)
    section .trade-records
       span = tradeRecordsTitle (menu.record) ; button.trade-records-link = trade.viewOrders
       .trade-record-item* : coin+"/USDT", formatTradeRecordTime(buytime), status text/class,
         trade.amount/orders.profitLoss/trade.direction/buyPrice/sellPrice/trade.duration
```
`tradingDisabledMessage`: uses `trade.weekendTradingDisabled` ("Weekend trading suspended") when `showCountdownCurrentStatus`/weekend logic triggers.

### Submit modal (`popup-fade`, `submitModal`)
```
.popup-overlay > .popup-overlay-center > .submit-modal
  header: span = coin + " " + trade.title   ("Trade"); close-btn "×"
  .submit-row: trade.time ":" [img time] currtimeLabel      (e.g. "60s")
               trade.direction ":" directionLabel (trade.up/trade.down)
  .duration-row: label trade.duration
     button.time-display [img time, currtimeLabel, img arrow]  -> opens timeModal
  .direction-row: button.type-btn up (trade.up) / button.type-btn down (trade.down)
  .range-row: label trade.range
     button.range-display [img up/down icon, directionLabel + " - " + currtimeLabel, oddsPercentage, img arrow]
  .wallet-row: label trade.wallet
     button.wallet-display [currWalletIcon img, currWalletLabel, arrow]
     input number placeholder=minAmountPlaceholder min="0" step="0.01"  -> num
  .balance-row: trade.balance ": " balanceLabel
                trade.expected ": " expectedPayout
  button.submit-popup (up|down) = trade.confirmOrder
```

### Sheets (`sheet`, popup-style)
- `timeModal`: header trade.selectDuration ("Select Duration") + "×"; items `.sheet-item` (active when id matches): `formatDuration(second)` (e.g. "60s") + `(100*odds).toFixed(0)%` (e.g. "180%").
- `upOrDownModal`: header trade.selectDirection ("Select Direction"); two `.sheet-item`: trade.up + `oddsForType("up")`, trade.down + `oddsForType("down")`.
- `walletModal`: header trade.selectWallet ("Select Wallet"); `.sheet-item` per wallet: coin + (balance || "0.00").

### Countdown modal (`popup-fade`, `countdownModal`)
```
header: trade.orderCountdown ("Order Countdown") + close-btn ×
if isSettling: .settling-spinner(.spinner) + div = trade.settling ("Settling...")
else:
  rows: trade.direction ":" Up/Down (up-text/down-text)
        trade.amount ":" activeOrder.amount || "0.00"
        trade.buyPrice ":" formatPrice(buyprice)
        trade.currentPrice ":" formatPrice(currentOrderPrice)
        trade.duration ":" formatOrderDuration(activeOrder)
  .countdown-display = countdownDisplay
  if showCountdownCurrentStatus: trade.currentStatus ":" preview-value (+/- orderProfitPreview.toFixed(2), class profit|loss)
```
`formatDuration(s)` = `` `${s}s` `` or `"0s"` (@4122). `formatOrderDuration` → `getOrderDurationSeconds` (duration|second|seconds, else buy→sell delta, /1000 if > 1e10) → `--` if 0.

### Result modal (`popup-fade`, `resultModal`)
```
header: trade.settlementResult ("Settlement Result") + close-btn ×
.result-icon (win|lose) = is_win ? "✓" : "X"
.result-amount (profit|loss) = is_win ? "+" : "" + calculateSettlementAmount
rows: trade.purchaseAmount ":" amount || "0.00"
      trade.direction ":" Up/Down
      trade.contract ":" contractDuration + "s"
      trade.purchasePrice ":" formatPrice(buyprice)
      trade.sellingPrice ":" formatPrice(sellprice)
button.result-btn primary = trade.continue  ("Continue Trading")
button.result-btn secondary = trade.viewOrders ("View Orders")
```

### API
- `Cr()` GET `/api/order/token` (CSRF token)
- `Pr()` POST `/api/order/create` `{coin, type, num, second, oid, contract_id, wallet, __token__}`
- `Lr(oid)` GET `/api/order/{oid}` → settlement `{oid, sellprice, is_win, profit(profit??ploss)}`, polled every 1s
- `Rr(contract_id?)` GET `/api/orders` (recent records, `contract_id` optional)
- Price feed: GET `/api/market/realtime` + `/api/market/all`; tick update sets `close`, `change`, `changeAmount`.

### EN strings used (trade.*)
title="Trade" contract="Contract" wallet="Wallet" direction="Direction" duration="Duration" range="Range" up="Up" down="Down" balance="Balance" expected="Expected" confirmOrder="Confirm Order" minAmount="Min" selectTime="Select" selectWallet="Select Wallet" selectDuration="Select Duration" selectDirection="Select Direction" startTrading="Start Trading" time="Time" open="Open" high="High" low="Low" close="Close" volume="Volume" enterValidAmount="Please enter a valid amount." amountMustBeAtLeast="Amount must be at least" weekendTradingDisabled="Weekend trading suspended" insufficientBalance="Insufficient balance" priceUnavailable="Price unavailable" orderCreated="Order created successfully" orderFailed="Order creation failed" orderError="Order creation error" orderCountdown="Order Countdown" amount="Amount" buyPrice="Buy Price" currentPrice="Current Price" currentStatus="Current Status" settlementResult="Settlement Result" profit="Profit" loss="Loss" newBalance="New Balance" sellPrice="Sell Price" continue="Continue Trading" viewOrders="View Orders" settlementFailed="Settlement failed" settlementError="Settlement error" orderInProgress="Order in progress, you can view it in the order list after closing" settling="Settling..." settlementTimeout="Settlement timeout, please check the order list later" purchaseAmount="Purchase Amount" purchasePrice="Purchase price" sellingPrice="Selling price"

---

## 2. AccountPage  (`/account`)

Component `Zs` @4926, render `Os` @4722, scopeId `data-v-1065e679`.

### Structure
```
header: back-btn (white chevron M15 18L9 12L15 6) ; h1 = account.title ("My Account")
section: h2 = account.cryptoWallet ("Crypto Wallet")
         p = account.manageYourAssets ("Manage Your Digital Assets")
         div.title-icon (inline SVG, white): rect x2 y5 w20 h14 rx2 + path M2 10h20 + circle cx17 cy14 r1.5
section.actions: 4 buttons .action-btn
   .action-btn.deposit  = account.deposit  ("Deposit")   icon: M12 2v20 / M12 2l-4 4 / M12 2l4 4 + wallet path (rect via path)   -> /funds
   .action-btn.withdraw = account.withdraw ("Withdraw")  icon: M12 22V2 / arrows + wallet path                                   -> /funds?tab=withdraw
   .action-btn.exchange = account.exchange ("Exchange")  icon: M7 16V4l-4 4m4-4l4 4 + M17 8v12l-4-4m4 4l4-4                  -> /exchange
   .action-btn.loan     = nav.loan        ("Loan")       icon: circle r10 + M12 6v6l4 2                                        -> /loan
section.wallets:
   .select-line ; h3 = account.yourWallets ("Your Wallets")
   loading: .spinner + common.loading ("Loading...")
   USDT card: img /bi/usdt.png (onError handleCoinImageError) ; h4.coin-name "USDT" ; p.coin-subtitle "Tether USD"
              p = "$ " + formatNumber(userBalance) ; p = formatNumber(userBalance) + " USDT"
   otherCoins: .wallet-item per coin: img getImageUrl(icon) ; coin-name / coin-subtitle ; balances
```
`formatNumber`: `Intl.NumberFormat("en-US")`; values < 0.01 → `toFixed(8).replace(/\.?0+$/, "")`.

### EN strings
account.title="My Account" account.cryptoWallet="Crypto Wallet" account.manageYourAssets="Manage Your Digital Assets" account.deposit="Deposit" account.withdraw="Withdraw" account.exchange="Exchange" account.yourWallets="Your Wallets" account.availableBalance="Available Balance"

---

## 3. OrdersPage  (`/orders`)

Component `ms` @4638, render `cs` @4490.

### Structure
```
header: back-btn (left chevron M15 18l-6-6 6-6, currentColor) ; h1 = orders.title ("Order List") ; div.header-placeholder
div.tabs: button.tab-btn active? → orders.all / orders.open / orders.closed   (activeTab: "all"|"open"|"closed")
loading: .loading-state + common.loading
empty: .empty-state + orders.noOrders ("No orders")
.order-card* (key=t.id):
   .product-icon: img t.img (getImageUrl) else div = t.ptitle.charAt(0)
   .ptitle + "/USDT"
   formatDateTime(t.buytime)
   .row: orders.amount ":" t.fee + " USDT"
   .row: orders.direction ":" (ostyle===0 ? trade.up : trade.down)  class up-text|down-text
   .row: orders.buyPrice ":" formatPrice(t.buyprice)
   .row: orders.sellPrice ":" (ostaus===1 ? formatPrice(t.sellprice,"--") : "--")
   .row: orders.sellTime ":" (ostaus===1 ? formatDateTime(t.selltime) : "--")
   .row: orders.profitLoss
   status badge classes: status-open / status-win / status-loss / status-closed
```
Record time uses `ba` (@1815): key list `Aa`, fields `time_str`/`timeStr` fallback.

### EN strings
orders.title="Order List" orders.all="All" orders.open="Open" orders.closed="Closed" orders.noOrders="No orders" orders.amount="Purchase Amount" orders.direction="Direction" orders.buyPrice="Buy Price" orders.sellPrice="Sell Price" orders.sellTime="Delivery Time" orders.profitLoss="Profit/Loss" orders.statusOpen="Open" orders.statusClosed="Closed" orders.statusWin="Profit" orders.statusLoss="Loss"

---

## 4. FundsPage  (`/funds`)

Component `Sd` @5687, render `Ld` @5167, scopeId `data-v-734f5b30`.

### Structure
```
header: back-btn (white chevron M15 18L9 12L15 6) ; h1 = funds.title ("Funds Management")
div.tabs: div.tab-item active? funds.recharge ("Deposit") | funds.withdraw ("Withdraw")   (activeTab "recharge"|"withdraw")
```

### Recharge tab (default)
```
div.address-item* (depositAddressList from window.AppConfig btc/eth/usdt/usdc):
   span symbol ; button.copy-btn = common.copy ("Copy") -> copyToClipboard(address)
   div = formatAddress(address)
div: label funds.currency ("Currency") ; .currency-chip* (rechargeForm.currency, click sets)
     (optional) .currency-chip* rechargeProtocols
div: label funds.amount ("Amount") ; input type=number placeholder=minRechargeAmountText min=minRechargeAmount step=any
div: label funds.paymentProof ("Payment Proof")
     if imageUrl: img preview + button.remove-btn funds.remove ("Remove")
     else .upload-area (📷) + p = funds.clickUpload ("Click to upload payment screenshot") + input file accept=image/*
div.tip: ℹ️ + funds.rechargeTip ("Please contact us before deposit") + a.service-link funds.customerService ("Customer Service") -> contactService
button.submit-btn = submitting ? funds.submitting : funds.submit  (disabled=!canSubmitRecharge||submitting)
div.history: funds.rechargeHistory ("Deposit History")
   empty: 📭 + funds.noRecords ("No records")
   .record-item*: "+"+amount+" "+currency(+USDT) ; is_virtual badge funds.virtualFunds ("Virtual Funds")
                 .record-status status-{status} getStatusText ; funds.orderNo ":" order_sn ; formatRecordTime
```
`minRechargeAmount` per currency (ETH .05); `canSubmitRecharge` = amount>0 && amount>=min && imageUrl && !submitting.

### Withdraw tab
```
div: funds.withdrawType ("Withdrawal Type") ; div.type-tab active? funds.cryptoCurrency ("Cryptocurrency") | funds.bankCard ("Bank Card")
  (withdrawForm.withdrawType = "crypto" | "bank")
crypto:
   label funds.currency + .currency-chip* (withdrawForm.currency, click sets)
   (optional) .currency-chip* withdrawProtocols
   label funds.withdrawAddress ("Withdrawal Address") ; input text placeholder funds.enterAddress ("Please enter withdrawal address")
bank:
   label funds.bankName / funds.routingNumber / funds.accountName / funds.bankCardNo + inputs
   placeholders: funds.enterBankName / funds.enterRoutingNumber / funds.enterAccountName / funds.enterBankCardNo
common:
   label funds.amount ; input placeholder=minWithdrawAmount
   row: funds.withdrawalFee ("Withdrawal fee") ; funds.actualAmount ("Actual amount")
button.submit-btn (withdraw)
div.history: funds.withdrawHistory ("Withdrawal History") — records "-"+amount, status, orderNo, time
```
Upload: `handleFileSelect` → `compressImage(file,800,0.8)` → POST `https://amiao.uploada.vip/`; fee = `AppConfig.withdrawalFeeRate`.

### EN strings
funds.title="Funds Management" funds.recharge="Deposit" funds.withdraw="Withdraw" funds.currency="Currency" funds.amount="Amount" funds.minAmount="Minimum deposit amount" funds.minWithdrawAmount="Minimum withdrawal amount" funds.paymentProof="Payment Proof" funds.clickUpload="Click to upload payment screenshot" funds.remove="Remove" funds.rechargeTip="Please contact us before deposit" funds.customerService="Customer Service" funds.submit="Submit" funds.submitting="Submitting..." funds.rechargeHistory="Deposit History" funds.withdrawHistory="Withdrawal History" funds.noRecords="No records" funds.orderNo="Order No." funds.status="Status" funds.statusPending="Pending" funds.statusApproved="Approved" funds.statusRejected="Rejected" funds.withdrawType="Withdrawal Type" funds.cryptoCurrency="Cryptocurrency" funds.bankCard="Bank Card" funds.withdrawAddress="Withdrawal Address" funds.enterAddress="Please enter withdrawal address" funds.bankName="Bank Name" funds.routingNumber="Routing Number" funds.accountName="Account Name" funds.bankCardNo="Bank Card Number" funds.enterBankName="Please enter bank name" funds.enterRoutingNumber="Please enter routing number" funds.enterAccountName="Please enter account name" funds.enterBankCardNo="Please enter bank card number" funds.withdrawTip="Withdrawal requests will be processed within 24 hours" funds.insufficientBalance="Insufficient balance" funds.amountRequired="Please enter amount" funds.addressRequired="Please enter withdrawal address" funds.bankInfoRequired="Please complete bank card information" funds.uploadRequired="Please upload payment proof" funds.rechargeSuccess="Deposit request submitted, please wait for review" funds.withdrawSuccess="Withdrawal request submitted, please wait for review" funds.uploadSuccess="Upload successful" funds.uploadFailed="Upload failed" funds.submitFailed="Submit failed, please try again" funds.selectImage="Please select an image file" funds.imageSizeLimit="Image size cannot exceed 5MB" funds.uploading="Uploading..." funds.virtualFunds="Virtual Funds" funds.withdrawalFee="Withdrawal fee" funds.actualAmount="Actual amount"

---

## 5. ExchangePage  (`/exchange`)

Component `ic` @5971, render `tc` @5758, scopeId `data-v-b13078e0`.

### Structure
```
header: back-btn (dark chevron M15 18L9 12L15 6, stroke #333) ; h1 = exchange.title ("Exchange")
div.form:
  div: label exchange.from ("From")
       select.currency-select (currencies, onUpdate fromCurrency, onChange handleCurrencyChange)
       input.amount-input type=number placeholder=exchange.enterAmount (onInput handleAmountChange)
  div: exchange.availableBalance ": " getBalance(from) + " " + from ; button.all-btn = exchange.all ("ALL") -> setMaxAmount
  div.exchange-icon: svg chevron-down (M7 10L12 15L17 10, currentColor)
  div: label exchange.to ("To")
       select.currency-select (currencies, toCurrency)
       input.amount-input.readonly value=toAmount placeholder=exchange.calculating
  div: exchange.availableBalance ": " getBalance(to) + " " + to
  if exchangeRate: div = exchange.exchangeRate (": 1 FROM = rate TO")
  button.exchange-btn = isExchanging ? exchange.exchanging : exchange.exchange  (disabled=isExchanging||!canExchange)
div.history: h3 = exchange.history ("Exchange History")
   loading: exchange.loading | empty: exchange.noRecords
   .record-item*: div: span e.from + svg.arrow-icon (M5 12H19M19 12L12 5M19 12L12 19) + span e.to ; div = formatRecordTime
```
`currencies: ["USDT","BTC","ETH","LTC","EOS","XRP","DOGE","TON","ADA","BNB","TRX","UNI","AVAX","USDC","XAU"]`, `from="USDT"`, `to="BTC"`.
`canExchange` = fromAmount>0 && toAmount>0 && from!==to && balances ok. `fetchRate` GET `/api/exchange/rate` (params from/to). `formatRecordTime` uses `ba({includeSeconds:false})`.

### EN strings
exchange.title="Exchange" exchange.from="From" exchange.to="To" exchange.fromCurrency="From Currency" exchange.toCurrency="To Currency" exchange.amount="Amount" exchange.availableBalance="Available Balance" exchange.exchangeRate="Exchange Rate" exchange.exchange="Exchange Now" exchange.history="Exchange History" exchange.time="Time" exchange.loading="Loading..." exchange.success="Exchange successful" exchange.failed="Exchange failed" exchange.selectCurrency="Please select currency" exchange.enterAmount="Please enter amount" exchange.insufficientBalance="Insufficient balance" exchange.calculating="Calculating..." exchange.exchangeDetails="Exchange Details" exchange.fromAmount="Pay" exchange.toAmount="Receive" exchange.confirmExchange="Confirm Exchange" exchange.cancel="Cancel" exchange.noRecords="No exchange records" exchange.refreshRate="Refresh Rate" exchange.rateUpdated="Rate updated" exchange.getRateFailed="Failed to get rate" exchange.sameCurrency="Please select different currencies" exchange.all="ALL" exchange.exchanging="Exchanging..." exchange.submitFailed="Submit failed, please try again"

---

## 6. LoanPage  (`/loan`)

Component `Kc` @6148 (name `LoanPage`), render `Hc` @6090, scopeId `data-v-9b5eb3b2`.

### Structure
```
header: back-btn (dark chevron) ; h1 = loan.title ("Loan")
div.form:
  div.limit: p = loan.loanLimit ("Loan Limit") ; span = formatNumber(maxLoanAmount) + span.currency "USD"
  div: label loan.loanPeriod ("Loan Period")
       select.form-select (onUpdate selectedPlan, onChange handlePlanChange):
          option = loan.selectPeriod ("Please select loan period")
          option* = t.days + " " + loan.days + " - [" + formatNumber(min_amount) + "-" + formatNumber(max_amount) + "] "
  div: label loan.amount ("Amount") ; input number placeholder=amountPlaceholder (min–max or loan.enterAmount) onInput calculateInterest
       if selectedPlanData: p = loan.amountRange ": " min + " - " + max  ("Amount Range")
  div: label loan.dailyRate ("Daily Rate") ; input readonly value=dailyRateDisplay ("0%"/"x%")
  div: label loan.totalInterest ("Total Interest") ; input readonly value=totalInterestDisplay ("$0.00"/"$x")
  button.submit-btn = isSubmitting ? (loan.submitting ? loan.submitting : common.loading) : loan.applyNow  (disabled=isSubmitting||!canSubmit)
div.history: h3 = loan.history ("Loan History")
   loading: loan.loading | empty: loan.noRecords ("No loan records")
   .record-item*: div: loan.amount ": $" formatNumber(amount) ; .record-status status-{t.status} getStatusText
      div: loan.loanPeriod ": " t.days + " " + loan.days
      div: loan.dailyRate ": " t.daily_rate + "%"
      div: loan.totalInterest ": $" formatNumber(total_interest)
      div: loan.time ": " formatRecordTime(t)
```
`fetchPlans` GET `/api/loan/plans` (`plans`, `max_loan_amount||1e6`); `fetchRecords` GET `/api/loan/records`; `calculateInterest = Math.round(amount*(daily_rate/100)*days)`; `canSubmit` = plan selected && amount within min/max.

### EN strings
loan.title="Loan" loan.loanLimit="Loan Limit" loan.loanPeriod="Loan Period" loan.days="Days" loan.amount="Amount" loan.dailyRate="Daily Rate" loan.totalInterest="Total Interest" loan.applyNow="Apply Now" loan.history="Loan History" loan.loading="Loading..." loan.noRecords="No loan records" loan.selectPeriod="Please select loan period" loan.enterAmount="Please enter loan amount" loan.amountRange="Amount Range" loan.minAmount="Minimum Amount" loan.maxAmount="Maximum Amount" loan.success="Loan application submitted" loan.failed="Loan application failed" loan.submitFailed="Submit failed, please try again" loan.invalidAmount="Please enter valid amount" loan.amountOutOfRange="Amount out of range" loan.status="Status" loan.statusPending="Pending" loan.statusApproved="Approved" loan.statusRejected="Rejected" loan.time="Time" loan.loanDetails="Loan Details" loan.interestCalculation="Interest Calculation" loan.totalRepayment="Total Repayment"

---

## 7. AIQuantPage  (`/ai`)

Component `Cm` @6652 (name `AIQuantPage`), render `ym` @6514, scopeId `data-v-d5bc62da`.

### Structure
```
header: back-btn (dark chevron) ; h1 = aiQuant.title ("AI Quantitative Trading")
        button.orders-btn (hamburger: M3 12h18M3 6h18M3 18h18) -> toggle showOrdersList
```
### Orders list view (`showOrdersList`)
```
h3 = aiQuant.myPositions ("My Positions")
loading: .spinner + aiQuant.loading | empty: aiQuant.noOrders ("No positions")
.order-card* (onClick viewOrderDetail):
   div: h4 = product_name ; span.status-badge {getStatusClass} = getStatusText
   div: aiQuant.investAmount ("Investment") ": " formatNumber(amount) + " USDT"
       aiQuant.totalProfit ("Total Profit") ": +" formatNumber(total_profit) + " USDT"
   div: aiQuant.runningDays({settled,total}) ("Running {settled}/{total} days") ; span = calculateProgress() + "%"
        div.progress-fill style width=calculateProgress()+"%"
   div: formatDateTime(start_time) ; chevron svg (M9 18l6-6-6-6, #999)
```
### Products view
```
div.hero: h2 = aiQuant.subtitle ("AI Smart Quantitative") ; p = aiQuant.description ("Professional quantitative strategy, stable returns")
h3.section-title (aiQuant.navTitle "AI Quant")
loading: spinner + aiQuant.loading | empty: aiQuant.noProducts ("No products available")
.product-card* (onClick selectProduct):
   div: h4 = name ; span = period_days + " " + aiQuant.days ("Days")
   div: span = daily_rate_min + "% - " + daily_rate_max + "%" ; span = aiQuant.dailyReturn ("Daily Return")
   div: aiQuant.minInvestment ("Min Investment") ": " formatNumber(min_amount) + " USDT"
       aiQuant.settlementMethod ("Settlement") ": " (compound_type===1 ? aiQuant.compound ("Compound") : aiQuant.dailySettle ("Daily Settle"))
   p = desc
   button = [svg plus M5 12h14m-7-7v14] + " " + aiQuant.buyNow ("Buy Now")
```
### Purchase modal (`modal-overlay > modal-content`)
```
header: h3 = aiQuant.buyTitle + " " + selectedProduct.name ("Buy <name>") ; button.close-btn ×
rows: aiQuant.period ("Period") ": " period_days + " " + aiQuant.days
      aiQuant.dailyReturn ": " rates
      aiQuant.profitMethod ("Profit Method") ": " compound|dailySettle
label aiQuant.investAmountLabel ("Investment Amount (USDT)")
input type=number placeholder=aiQuant.enterAmount min=min_amount max=max_amount||999999999
button.max-btn = aiQuant.all ("All") -> setMaxAmount
aiQuant.minimum (": min") | (max>0) aiQuant.maximum (": max") | aiQuant.available (": balance")
h4 = aiQuant.estimatedProfit ("Estimated Profit")
   aiQuant.dailyProfitEst ("Est. Daily Profit") ": " calculateDailyProfit() + " USDT"
   aiQuant.totalProfitEst ("Est. Total Profit") ": " calculateEstimateProfit() + " USDT"
button.confirm-btn = purchasing ? aiQuant.purchasing : aiQuant.confirmPurchase  (disabled=purchasing)
```
### Detail modal (`modal-overlay > modal-content.detail-modal`)
```
header: h3 = aiQuant.orderDetails ("Order Details") ; close-btn ×
basicInfo block:
   aiQuant.productName ("Product") ": product_name
   aiQuant.investAmount ": amount USDT
   aiQuant.currentPrincipal ("Current Principal") ": current_principal USDT
   aiQuant.cumulativeProfit ("Cumulative Profit") ": +total_profit USDT
   aiQuant.startTime ("Start Time") ": formatDateTime(start_time)
   aiQuant.endTime ("End Time") ": formatDateTime(end_time)
if schedules.length: h4 = aiQuant.profitPlan ("Profit Plan")
   .schedule-item (settled|pending): aiQuant.day({day}) ; if settled: aiQuant.profitRate ": " profit_rate + "%" ; aiQuant.profit ": " profit_amount + " USDT"
      time = settled ? formatDateTime(real_settle_time) : formatDateTime(plan_settle_time) ; aiQuant.settled ("Settled") | aiQuant.pending ("Pending")
```
`loadProducts` GET `/api/ai/products` sorted by `period_days`; `loadOrders` GET `/api/ai/orders` (lazy); statuses: 1 Running, 2 Settled, 3 Cancel, 4 Pending (`getStatusClass`).

### EN strings
aiQuant.title="AI Quantitative Trading" aiQuant.navTitle="AI Quant" aiQuant.subtitle="AI Smart Quantitative" aiQuant.description="Professional quantitative strategy, stable returns" aiQuant.loading="Loading..." aiQuant.noProducts="No products available" aiQuant.noOrders="No positions" aiQuant.days="Days" aiQuant.dailyReturn="Daily Return" aiQuant.minInvestment="Min Investment" aiQuant.settlementMethod="Settlement" aiQuant.compound="Compound" aiQuant.dailySettle="Daily Settle" aiQuant.buyNow="Buy Now" aiQuant.myPositions="My Positions" aiQuant.investAmount="Investment" aiQuant.totalProfit="Total Profit" aiQuant.running="Running" aiQuant.runningDays="Running {settled}/{total} days" aiQuant.details="Details" aiQuant.buyTitle="Buy" aiQuant.period="Period" aiQuant.profitMethod="Profit Method" aiQuant.investAmountLabel="Investment Amount (USDT)" aiQuant.enterAmount="Enter investment amount" aiQuant.all="All" aiQuant.minimum="Min" aiQuant.maximum="Max" aiQuant.available="Available" aiQuant.estimatedProfit="Estimated Profit" aiQuant.dailyProfitEst="Est. Daily Profit" aiQuant.totalProfitEst="Est. Total Profit" aiQuant.purchasing="Purchasing..." aiQuant.confirmPurchase="Confirm Purchase" aiQuant.cancel="Cancel" aiQuant.orderDetails="Order Details" aiQuant.basicInfo="Basic Info" aiQuant.productName="Product" aiQuant.currentPrincipal="Current Principal" aiQuant.cumulativeProfit="Cumulative Profit" aiQuant.startTime="Start Time" aiQuant.endTime="End Time" aiQuant.profitPlan="Profit Plan" aiQuant.day="Day {day}" aiQuant.profitRate="Profit Rate" aiQuant.profit="Profit" aiQuant.settled="Settled" aiQuant.pending="Pending" aiQuant.close="Close" aiQuant.pleaseLogin="Please login first" aiQuant.amountRequired="Please enter investment amount" aiQuant.amountTooLow="Amount cannot be less than minimum" aiQuant.amountTooHigh="Amount cannot exceed maximum" aiQuant.insufficientBalance="Insufficient balance" aiQuant.purchaseSuccess="Purchase successful" aiQuant.purchaseFailed="Purchase failed" aiQuant.loadFailed="Load failed"

---

## 8. AuthenticationPage  (`/authentication`)  +  AdvancedAuthenticationPage (`/advanced-authentication`)

Auth: component `mh` @7191, render `uh` @6939, scopeId `data-v-5f1f0fac`.
AdvAuth: component `Kh` @7530, render `Hh` @7297, scopeId `data-v-24304187`.

### Auth structure
```
header: back-btn (white chevron) ; h1 = authentication.title ("Identity Verification")
section: h2 = authentication.title
   status p: 1 → authentication.approvedMessage ("Your identity verification has been approved")
             0 → authentication.pendingMessage ("Your verification is under review, please wait patiently")
             2 → authentication.rejectedMessage ("Your verification was rejected, please resubmit")
             else → authentication.uploadTip ("Please upload a clear photo of the front of your ID")
   div.title-icon inline SVG (white): rect x3 y4 w18 h16 rx2 + circle cx9 cy10 r2 + path M3 16l4-4 4 4 8-8
form (status===-1 || status===2):
   label authentication.realName ("Full Name") ; input text placeholder authentication.realNameRequired
   label authentication.email ("Email") ; input email placeholder authentication.emailRequired
   label authentication.idNumber ("ID Number") ; input text placeholder authentication.idNumberRequired
   label authentication.phone ("Phone Number") ; input tel placeholder authentication.phoneRequired
   label authentication.idPhoto ("ID Photo")
      if pic: img getImageUrl(pic) alt "ID Photo" + button.remove-btn funds.remove ("Remove")
      else .upload-area (📷) + p authentication.uploadTip + input file accept=image/*
   button.submit-btn: submitting ? authentication.submitting : (status===2 ? authentication.resubmit : authentication.submit)
                      ("Submitting..." / "Resubmit" / "Submit")  disabled=submitting
status-card (when approved/pending):
   .status-card.status-{status}: icon svg (green #10B981 check: circle + M8 12l3 3 5-6) | (amber #F59E0B clock: circle + M12 8v4m0 4h.01)
   h3 = authentication.approved ("Verified") | authentication.pending ("Under Review")
   p = approvedMessage | pendingMessage
```
`loadAuthStatus` GET `/api/authentication/status` (form fields `username/email/userid/utel/pic`); submit POST `/api/authentication/submit`; not logged in → toast `authentication.notLoggedIn` + redirect `/login` after 1.5s. Upload compress 800/0.8.

### AdvAuth structure (same pattern)
```
header: back-btn (white) ; h1 = advancedAuth.title ("Advanced Authentication")
section: h2 = advancedAuth.title ; status p (default → advancedAuth.photoRequired "Please upload handheld ID photo")
   div.title-icon inline SVG (white): rect x3 y6 w18 h14 rx2 + path M9 12h6M12 9v6
form (status===-1 || 2):
   label advancedAuth.idPhotoWithHand ("Handheld ID Photo")
   if pic2: img alt "ID Photo with Hand" + remove-btn funds.remove
   else .upload-area 📷 + advancedAuth.uploadTip ("Click to upload handheld ID photo") + file input
   button.submit-btn: submitting/resubmit/submit ("Submitting..."/"Resubmit"/"Submit")
status-card: icon (same check/clock), h3 = approved/pending, p = approvedMessage/pendingMessage
```
`loadAuthStatus` GET `/api/advanced-auth/status`; submit POST `/api/advanced-auth/submit`.

### EN strings
authentication.title="Identity Verification" realName="Full Name" idNumber="ID Number" phone="Phone Number" email="Email" idPhoto="ID Photo" uploadIdPhoto="Upload ID Photo" submit="Submit" resubmit="Resubmit" status="Verification Status" notSubmitted="Not Verified" pending="Under Review" approved="Verified" rejected="Rejected" pleaseUpload="Please upload ID photo" uploadTip="Please upload a clear photo of the front of your ID" realNameRequired="Please enter your full name" idNumberRequired="Please enter your ID number" phoneRequired="Please enter your phone number" emailRequired="Please enter your email" photoRequired="Please upload ID photo" submitting="Submitting..." submitSuccess="Verification submitted successfully, please wait for review" submitFailed="Submit failed, please try again" uploadFailed="Upload failed" invalidImageType="Please upload JPG, PNG or GIF image" pendingMessage="Your verification is under review, please wait patiently" approvedMessage="Your identity verification has been approved" rejectedMessage="Your verification was rejected, please resubmit" selectImage="Select Image" previewImage="Preview" loading="Loading..." back="Back" notLoggedIn="Please login first" alreadyApproved="You are already verified" pendingReview="You have submitted verification, please wait for review"

advancedAuth.title="Advanced Authentication" idPhotoWithHand="Handheld ID Photo" photoRequired="Please upload handheld ID photo" uploadTip="Click to upload handheld ID photo" uploadHint="Please hold your ID card and take a clear photo" submit="Submit" resubmit="Resubmit" submitting="Submitting..." submitSuccess="Submitted successfully" submitFailed="Submission failed" uploadFailed="Upload failed" invalidImageType="Please upload an image file" approved="Authentication Approved" approvedMessage="Your advanced authentication has been approved" pending="Under Review" pendingMessage="Your advanced authentication is under review" rejected="Authentication Rejected" rejectedMessage="Your advanced authentication was rejected, please resubmit" notLoggedIn="Please login first" alreadyApproved="Advanced authentication already approved" pendingReview="Already submitted, under review"

---

## 9. Side drawer  (SideMenu)

Component `Ka` @2082 (name `SideMenu`), render `Ha` @1893, scopeId `data-v-4c70d668`.

### Structure
```
div.side-menu-overlay (click -> close) > div.side-menu (stop)
   header: h2.menu-title = "Web3.0" (HARDCODED)
           div = "ID:" + (userId || menu.notLoggedIn)   ("Not Logged In")
           button.close-btn × (svg M18 6L6 18M6 6L18 18)
   div.vip-area: userInfo.vip !== 0 → img.vip-image getVipImage()  else span = menu.function ("Function")
   div.menu-list:
      div.menu-item (account)      → menu.account ("Account")       icon: circle cx12 cy8 r4 + path M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2
      div.menu-item (authentication) → menu.authentication ("Authentication") icon (inline, data-v-4c70d668): rect x3 y11 w18 h10 rx2 + circle cx12 cy16 + path m7 11V7a5 5 0 0 1 10 0v4
      if advancedAuthEnabled: div.menu-item (advancedAuth) → menu.advancedAuth ("Advanced Authentication") icon: diamond path M12 2L2 7l10 5 10-5-10-5z + M2 17l10 5 10-5M2 12l10 5 10-5
      div.menu-item (record)       → menu.record ("Record")        icon: document path M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5...
      div.menu-item (chat)         → nav.cashService ("Cash Service") icon: chat bubble M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z
      if !isWalletLogin: div.menu-item (changePassword) → menu.changePassword ("Change Password") icon: rect x3 y11 w18 h11 rx2 + path M7 11V7a5 5 0 0 1 10 0v4
      div.menu-item (quit)         → menu.quit ("Quit")             icon: path M9 21H5... + M7 14l5-5-5-5m5 5H9
```
### Change-password modal (`modal-overlay > modal-content`)
```
h3 = changePassword.title ("Change Password") ; button.modal-close-btn ×
fields: changePassword.oldPassword (placeholder enterOldPassword "Enter old password")
        changePassword.newPassword (placeholder enterNewPassword "Enter new password")
        changePassword.confirmPassword (placeholder enterConfirmPassword "Confirm new password")
        all inputs type=password class=form-control
buttons: btn-cancel = changePassword.cancel ("Cancel") ; btn-submit = submitting ? changePassword.submitting : changePassword.submit
```
`getVipImage`: VIP1 → `img/vip1.svg`, VIP2 → `img/vip2.svg`, VIP3 → `img/vip3.svg` (asset map). Password change POST `/api/user/changePassword.html` (validates `passwordTooShort` ≥6, `passwordMismatch`).

### EN strings
menu.function="Function" menu.account="Account" menu.authentication="Authentication" menu.advancedAuth="Advanced Authentication" menu.record="Record" menu.share="Share" menu.resetPassword="Reset Password" menu.chat="Chat" menu.changePassword="Change Password" menu.quit="Quit" menu.notLoggedIn="Not Logged In"

changePassword.title="Change Password" oldPassword="Old Password" newPassword="New Password" confirmPassword="Confirm Password" enterOldPassword="Enter old password" enterNewPassword="Enter new password" enterConfirmPassword="Confirm new password" submit="Change" cancel="Cancel" submitting="Submitting..." success="Password changed successfully" failed="Failed to change password" oldPasswordRequired="Please enter old password" newPasswordRequired="Please enter new password" passwordTooShort="Password must be at least 6 characters" passwordMismatch="Passwords do not match"

---

## 10. Router table  (`Jh` @7584, routes `Xh` @7531)

| path | name | component |
|---|---|---|
| `/` | — | `redirect: () => window.AppConfig?.walletLoginEnabled ? "/home" : "/login"` |
| `/login` | Login | `Ge` |
| `/register` | Register | `ft` |
| `/home` | Home | `li` |
| `/market/:pid` | MarketDetail | `zr` (props:true) |
| `/orders` | Orders | `hs` |
| `/account` | Account | `Hs` |
| `/funds` | FundsManagement | `Nd` |
| `/exchange` | Exchange | `nc` |
| `/loan` | Loan | `Yc` |
| `/ai` | AIQuant | `Lm` |
| `/authentication` | Authentication | `ph` |
| `/advanced-authentication` | AdvancedAuthentication | `Yh` |

Navigation guard (@7588): whitelist `["/login","/register","/home","/"]`; for any other path fetch `${apiBaseUrl}/api/user/info.html` (GET, credentials include); allow only if `type===1 && logged_in===true`, else redirect `/login` (console.error "检查登录状态失败:" on exception).

Component map: `Ge=LoginPage`, `ft=RegisterPage`, `li=HomePage`, `zr=MarketDetail`, `hs=OrdersPage`, `Hs=AccountPage`, `Nd=FundsPage`, `nc=ExchangePage`, `Yc=LoanPage`, `Lm=AIQuantPage`, `ph=AuthenticationPage`, `Yh=AdvancedAuthenticationPage`.

---

## 11. HomePage header — logged-in state  (`ca` @1444)

Component `si` @2758, scopeId `data-v-72c19de8` (bottom-nav icons inline @1558–1590).

```
header:
  button.menu-btn (hamburger M3 12H21M3 6H21M3 18H21, white) -> toggleMenu
  if walletLoginEnabled && !walletConnected && !isLoggedIn:
     button.wallet-connect-btn (disabled=connectingWallet):
        svg (20x20): rect x2 y6 w20 h14 rx2 + path M6 6V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2 + circle cx16 cy13 r1
        span = connecting ? wallet.connecting ("Connecting...") : wallet.connect ("Connect Wallet")
  if isLoggedIn:
     div.wallet-address:
        svg (16x16): same wallet glyph
        span.wallet-balance = "$ " + formatBalance(userBalance)
  div.header-right:
     div.language-selector:
        button.language-btn = getCurrentLanguageLabel() + chevron svg (M4 6L8 10L12 6)
        if showLanguageMenu: div.language-menu > .language-option* (active if currentLocale===value, onClick selectLanguage)
hero-section: h1.hero-title = appTitle ; .hero-description = customDescription || hero.description ("Smart Trading Starts Here\nTrusted Multi-Asset Trading Platform") ; img.logo-image src=logoUrl
nav.bottom-nav: .nav-item* (account/home/orders icons, 30x30 svgs) -> goToAccount etc.
```
Wallet connect flow: `qe()` (WalletConnect v2 appDescription "Trust Wallet EIP-6963 + WalletConnect v2", UMD from jsdelivr/unpkg) → `bindConnectedWalletEvents(Ze)` → `ge()` challenge → `pe()` POST `/api/wallet/login`; not-found → `wallet.notFound`. Service: `ue()` → `customerServiceUrl?uid&utel&usermoney`.

### EN strings
wallet.connect="Connect Wallet" wallet.connecting="Connecting..." wallet.connected="Connected" wallet.disconnect="Disconnect" wallet.loginSuccess="Wallet login successful" wallet.loginFailed="Wallet login failed" wallet.connectFailed="Failed to connect wallet" wallet.noAccountsFound="No wallet accounts found" wallet.challengeFailed="Failed to get challenge" wallet.invalidParams="Invalid parameters" wallet.invalidChallenge="Invalid challenge" wallet.challengeExpired="Challenge expired" wallet.signatureFailed="Signature failed" wallet.signatureVerificationFailed="Signature verification failed" wallet.notFound="No wallet detected. Please install a wallet extension." wallet.userRejected="User rejected the request"

hero.description="Smart Trading Starts Here\nTrusted Multi-Asset Trading Platform"

---

## 12. Countdown / validation / toast strings (shared)

### Trade countdown & validation (trade.*)
- `trade.selectDuration` "Select Duration" (sheet title), option label `formatDuration` = "60s"/"120s"/"300s" + odds "180%"/"190%"/"210%".
- `trade.selectTime` "Select" (fallback currtime label when none).
- Validation toasts: `trade.enterValidAmount` "Please enter a valid amount." / `trade.amountMustBeAtLeast` "Amount must be at least" / `trade.weekendTradingDisabled` "Weekend trading suspended" / `trade.insufficientBalance` "Insufficient balance" / `trade.priceUnavailable` "Price unavailable".
- Order lifecycle: `trade.orderCreated` "Order created successfully" / `trade.orderFailed` "Order creation failed" / `trade.orderError` "Order creation error" / `trade.orderCountdown` "Order Countdown" / `trade.settling` "Settling..." / `trade.settlementFailed` "Settlement failed" / `trade.settlementError` "Settlement error" / `trade.settlementTimeout` "Settlement timeout, please check the order list later" / `trade.orderInProgress` "Order in progress, you can view it in the order list after closing".
- Result: `trade.settlementResult` "Settlement Result", `trade.continue` "Continue Trading", `trade.viewOrders` "View Orders".

### Common
common.ok="OK" common.copy="Copy" common.language="Language" common.loading="Loading..." common.loadError="Loading failed, please try again later" common.retry="Retry" common.networkError="Network error, please try again later" common.invalidRequestMethod="Invalid request method" common.comingSoon="Coming Soon" common.notifications="Notifications" common.noNotifications="No notifications" common.markAsRead="Mark as Read" common.success="Success" common.operationFailed="Operation failed"

### Auth token
auth.tokenInvalid="Form has expired, please refresh and try again"

### Login/Register (LoginPage `He` @902 render `j` @84, scopeId `data-v-d1812aa4`; RegisterPage `At` @1314 render `vt` @1076)
Classes: `.login-container`, `.login-top-left`, `.login-wrapper`, `.language-selector`/`.language-menu`, `.wallet-login-mode`, `.logo`, `.input-group`, `.remember-me`, `label[for="remember"]`, `.links`. Login POST `/api/login/login.html {username,upwd,__token__}` after GET `/api/login/token.html`; register POST `/api/register/...` with `{username,password,__token__}`; rememberMe persists localStorage `savedUsername/savedPassword/rememberMe`. Wallet login reuses Home flow (`qe()`).

### Dates
`formatDateTime` (orders sellTime, notice time, record times) → `YYYY-MM-DD HH:mm:ss`-style via key list `Aa` (`fa`) on fields `time_str`/`timeStr` fallback; `formatRecordTime` (exchange/loan/funds) omits seconds. `formatNoticeTime`/`formatNoticeContent` for home notices (`my_fee`).

---

## Appendix A — full EN dict key/value (verbatim)

```
hero.description = "Smart Trading Starts Here\nTrusted Multi-Asset Trading Platform"
nav.account="Account" nav.authentication="Authentication" nav.loan="Loan" nav.service="Service" nav.cashService="Cash Service"
market.title="Market" market.crypto="Crypto" market.metal="Metal" market.forex="Forex" market.hours24="24 Hrs" market.comingSoon="Coming Soon"
trade.*  (see section 1)
common.*  (see section 12)
auth.tokenInvalid="Form has expired, please refresh and try again"
wallet.*  (see section 11)
menu.*  (see section 9)
orders.*  (see section 3)
account.*  (see section 2)
funds.*  (see section 4)
exchange.*  (see section 5)
loan.*  (see section 6)
authentication.*  (see section 8)
changePassword.*  (see section 9)
advancedAuth.*  (see section 8)
aiQuant.*  (see section 7)
```
login.* / register.* entries are in `helpers/out/dict_en.txt` lines 1–40 (e.g. login.title, login.username, login.password, login.login, login.forgotPassword, login.noAccount, login.registerNow, login.walletLogin, login.loginSuccess, login.loginFailed, login.rememberMe, register.title, register.username, register.password, register.confirmPassword, register.email, register.phone, register.register, register.backLogin, register.agreeTerms, register.termsError, register.success, register.failed, register.passwordMismatch, register.passwordTooShort, register.enterUsername, register.enterPassword, register.enterEmail, register.enterPhone, register.usernameExists).

---

## Appendix B — API endpoint map

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/login/token.html` | login CSRF token |
| POST | `/api/login/login.html` | password login `{username,upwd,__token__}` |
| GET | `/api/register/token.html` | register CSRF token |
| POST | `/api/register/login.html` (register) | `{username,password,__token__}` |
| GET | `/api/user/info.html` | user info / auth guard |
| POST | `/api/user/changePassword.html` | change password |
| GET | `/api/market/all` | market list |
| GET | `/api/market/realtime` | realtime quotes |
| GET | `/api/market/kline` | kline series |
| GET | `/api/order/token` | order CSRF token |
| POST | `/api/order/create` | create trade order |
| GET | `/api/order/{oid}` | order detail/settlement |
| GET | `/api/orders` | order list (`contract_id?`) |
| GET | `/api/orders/contract` | contracts |
| GET | `/api/wallet/login` | wallet challenge |
| POST | `/api/wallet/login` | wallet login submit |
| POST | `/api/wallet/bind` | wallet bind |
| GET | `/api/wallet/connect/url` | wallet connect URL redirect |
| POST | `/api/wallet/unbind` | disconnect |
| GET | `/api/wallet/balance` | wallet balances |
| GET | `/api/exchange/rate` | exchange rate |
| POST | `/api/exchange/submit` | exchange |
| GET | `/api/exchange/records` | exchange history |
| GET | `/api/loan/plans` | loan plans |
| GET | `/api/loan/records` | loan history |
| POST | `/api/loan/submit` | apply loan |
| GET | `/api/ai/products` | AI products |
| GET | `/api/ai/orders` | AI positions |
| POST | `/api/ai/purchase` | buy AI product |
| GET | `/api/authentication/status` | verification status |
| POST | `/api/authentication/submit` | submit verification |
| GET | `/api/advanced-auth/status` | advanced status |
| POST | `/api/advanced-auth/submit` | advanced submit |
| POST | `https://amiao.uploada.vip/` | image upload (compress 800×0.8) |

---

## Appendix C — asset URLs

- `img/icon_pro_collect.bf32e20c.b24f05d9.svg`, `img/icon_pro_record.e0ae5e13.d6b2f78f.svg`, `img/icon_time.20dd9c20.9a6f791d.svg`, `img/icon_arrow_down.fca20a50.c7fd74d0.svg`, `img/green_up.19f36634.02d57a4a.svg`, `img/red_down.82c00110.a0954a09.svg`, collect = inline PNG.
- `img/img_banner_1.330f874d.6a96d630.png`, `img/img_share.c6632a1c.2ce688a9.png`, `img/icon_menu_wallet.e9b0e83b.9aa5c0d4.svg`, `img/img_wallet.e04efaed.062eb968.a440db9e.png`, `img/vip1.svg`, `img/vip2.svg`, `img/vip3.svg`, `/bi/usdt.png` (coin fallback).
```
