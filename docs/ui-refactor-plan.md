# UI Refactor — "Quiet Console"

決策已定，尚未動到任何 production 檔案。這份文件是設計契約 ＋ 分階段實作計畫 ＋ 交接指示。

規格檔都放在 `docs/ui-refactor/`（**注意**：早期的探索檔在 `docs/superpowers/mockups/`，那個目錄被 `.gitignore:21` 排除，只存在於原作者的機器上，不要引用）：

| 檔案 | 用途 |
|---|---|
| `docs/ui-refactor-plan.md` | 這份文件。唯一的規格來源 |
| `docs/ui-refactor/mockup-b2-quiet-console.html` | **視覺定稿**。HTML 註解裡寫了每個決定的理由 |
| `docs/ui-refactor/F1-desktop-final-folder-view.png` | 桌機 · by folder 檢視 |
| `docs/ui-refactor/F4-sessions-latest-updated.png` | sessions · latest updated（含 needs-you 釘選） |
| `docs/ui-refactor/F5-mobile-final.png` | 手機 |
| `docs/ui-refactor/engine-placement-compare.html` | 引擎讀數六種放置法的比較（已定案為 thread ↘，保留供日後爭論用） |

mockup 是靜態 HTML，直接用瀏覽器開，或照 §5 的 playwright 做法截圖。上方 toolbar 可切明暗、三種 agent、identity 三模式、working/idle、兩種 sessions 檢視——**那排 toolbar 是 mockup 的鷹架，不是要實作的 UI**。

被淘汰的方向（不要再回頭做）：A · 全平面、C · 浮動 chrome、B · B2 的前身（品牌色版本）。它們只在原作者機器的 `docs/superpowers/mockups/` 裡。

---

## 1. 設計契約

後面每一個「這裡要用什麼顏色 / 要不要加框」的問題，都由這四條決定，不要逐案討論。

### 1.1 顏色只有四種語意

| 顏色 | 只代表 | token |
|---|---|---|
| ink（近黑／近白） | 可互動、active、進行中 | `--ink` / `--on-ink` |
| amber | 需要你處理（permission、needs input） | `--warn` |
| red | 失敗、diff `−` | `--err` |
| green | **只有** diff `+` | `--ok` |
| muted / faint | metadata、已完成 | `--muted` / `--faint` |

推論出來的規則：

- **primary action 一律 ink**。Allow / Send / Review 不隨 agent 變色。`--permission-allow-bg`（`styles.css:14`）目前綁 `--agent-color`，要改掉。
- **完成狀態不給顏色、不給 badge**，只留耗時（`42ms`）。長 thread 不會佈滿綠色 `DONE`。
- **健康狀態沉默**。連線正常時 `connected` 是 muted 純文字，沒有綠點；斷線才變紅。
- **green 只在 diff `+`**，所以 `--ok` 不得用於「成功」以外任何裝飾。

### 1.2 身分用字，不用色

agent 身分是 mono 小寫字樣（`claude` / `codex` / `opencode`），不是色相。`--agent-color` 只保留給一顆 7px 的識別色塊 `.idot`，且該色塊預設關閉。

- 三段模式做成 `data-identity="mono | dot | hue"`：`mono` 全畫面零品牌色（**預設**）、`dot` 只在那 7px 出現、`hue` 是舊行為（保留給不喜歡的人，不是預設）。
- 落地掛點是現成的 `applySkin()`（`web/src/store/store.ts:61`）與 `--agent-color`（`store.ts:70`）。

### 1.3 只有機器產物有框

訊息是頁面上的文字，沒有 bubble、沒有面板、沒有標題列。**有框的只有**：tool call、permission prompt、composer、三個 panel（sessions / thread / changes）。

已刪除的容器：user 訊息面板、agent 訊息面板、thinking 獨立區塊、sidebar 的 Recent/All tabs、changes 的 summary 列、status bar 的三個 segment、crumb 的兩個重複 tag。

### 1.4 同一個事實只出現一次

- crumb = 你在哪（path › session title）
- dock = 現在用什麼在跑（agent · model · thinking level）
- status bar = 機器層事實（連線、diffstat、context、quota、terminal）
- turn label = 當時用什麼產生的（歷史記錄，與 dock 不同語意，不算重複）

---

## 2. 不改的東西

- 路由、store 形狀、SSE / ACP 協定、gateway API。這是純前端呈現層改動。
- `data-text-size`（`store.ts:56`）四段字級。
- 深色模式沿用 `prefers-color-scheme`。
- `App.tsx:12-26` 那段「不要對 Terminal 做 code splitting」的註解與現狀。

### 2.1 `Thread.tsx` 的可動範圍（重要，不是全檔禁改）

P1 一定會動到這個檔案，所以要精確劃線，不能寫成「一行都不要動」：

| | 範圍 |
|---|---|
| **可以動** | `shown.map()` 裡的 `switch (it.kind)` 各個 render case（`Thread.tsx:265-295`），以及在它之外新增純 render 用的分組函式 |
| **絕對不要動** | 所有 `useEffect` / `useLayoutEffect`、`structuralSig`（`:224-226`）、`jumpToBottom`、`forceRepaint`、`atBottom` / `anchorHeight` / `pagingRef`、visible-window 分頁（`INITIAL_VISIBLE` / `REVEAL_STEP` / `NEAR_TOP_PX`） |

**硬性約束**：`items`（`:166`）不得被改寫、重排或合併，`structuralSig` 的計算方式一字不改。`structuralSig` 是從 `items` 算的，`shown`（`:169`）只是它的 slice——所以把 `shown` **在 render 時**分組成 turn 是安全的，那不會改到 `items.length` 也不會改到那個字串。任何會讓 `items` 長度或 `structuralSig` 內容改變的做法都是禁止的，因為 `forceRepaint` 綁在它上面，那是 issue #98（iOS/PWA 畫面空白）的修正。

### 2.2 mockup 不是文案的來源

mockup HTML 裡的 `think:high`、`reason:medium`、`opus-5` 都是假字串。實際顯示一律用 `ConfigOption.name` / `Model.name` 回報的值（見 P3）。照抄 mockup 的字面是最可能發生的錯誤。

---

## 3. 實作階段

每一階段獨立可上線、可單獨驗收。順序是刻意的：先換 token（風險最低、影響最廣），最後才動資料流。

### P0 · Token 與顏色紀律
**檔案**：`web/src/styles.css`（僅 `:root` 區塊與少數規則）

1. 新增 `--ink` / `--on-ink`，把 `--accent` 預設指向 `--ink`；`--permission-allow-bg` 改為 `var(--accent)`。
2. 新增 `:root[data-identity="hue"]` 覆寫，讓 `--accent: var(--agent-color)`（保留舊行為）。
3. 刪除 `.content::before` 那條 3px 識別色鐵軌（`styles.css:129-132`）。B2 沒有它。
4. tool 的 `.tstatus.completed` 拿掉顏色與底色，只留耗時。
5. `--ok` 的用途限縮到 diff `+`。

**驗收**：明暗 × claude/codex/opencode 六種組合下，畫面上的彩色只剩 permission 的 amber 與 diff 的紅綠。Allow / Send 是黑（暗色為白）。

### P1 · 拆掉 thread 的容器
**檔案**：`styles.css`、`components/Thread.tsx`、`components/ToolCall.tsx`、`components/PermissionPrompt.tsx`

1. user turn：拿掉 `.bubble`，改成 `YOU · 14:02` 的 mono 標籤列 ＋ 純文字。
2. assistant turn：拿掉外框，改成一行 mono 標籤列（P3 會往裡面加 model / level）。
3. thinking：從獨立 `<details className="thinking">` 區塊（`Thread.tsx:284-288`）收進 assistant 的標籤列，變成 `· thought 6s ⌄`。
4. tool card：header 只留 `kind` + 路徑 + 右側耗時／狀態文字，拿掉狀態 pill 的邊框。
5. permission：拿掉 header 條，改成 2px amber 左邊框 ＋ `needs you` 一行。

**第 3 點的做法（唯一允許的做法）**：`thought` 目前是 `items` 裡獨立的一筆，跟它後面的 `assistant` 是兩個 item。**不要在 store 裡把它們合併**——那會改變 `items.length` 與 `structuralSig`，破壞 issue #98 的重繪修正（見 §2.1）。正確做法是在 `Thread.tsx` 裡加一個純 render 用的分組函式，把 `shown` 這個陣列在畫之前折成 turn（連續的 `thought` + `assistant` 視為同一個 turn，共用一行標籤），`items` 與 `structuralSig` 完全不動。

**驗收**：長 thread 的巢狀框從每則訊息一層降到零；tool call 與 permission 仍是唯一有框的東西。另外必須確認 iOS/PWA 上串流時畫面不會空白（issue #98 沒有回歸）——這是這一階段唯一有實質回歸風險的地方。

### P2 · Chrome：crumb / status bar / composer / changes
**檔案**：`components/TopBar.tsx`、`App.tsx`、`components/FilePanel.tsx`、`styles.css`

1. **TopBar → crumb**（32px）：`~/git/my-apps/**repo** › session title` ＋ 右側 `⋯`。
2. **status bar**：`App.tsx:157-170` 目前只有 terminal chip ＋ `UsageStrip`。擴成完整狀態列：`connected │ diffstat │ ……… │ ctx │ 5h │ term ⌃\``。
   - diffstat 可由 FilePanel 已有的 per-file `additions/deletions`（`FilePanel.tsx:137`）在 client 端加總，不需要後端改動。
   - **branch 名稱目前沒有資料來源**（`types.ts` / `workspace.ts` 都沒有 branch 欄位）。這一格先不做；要做就是另一張票，gateway 加欄位。
3. **changes panel**：把 summary 列折進 panel header（`Changes  7 files · +128 −35`）。
4. **composer**：維持現狀結構，只換樣式（hairline、mono send）。

> **這一階段有一個必須明講的功能取捨。** TopBar 現在有兩個 badge：`RunningTasks`（跨 agent 正在跑的工作，可跳過去）與 `PendingPermissions`（跨 agent 待回覆的權限請求）。B2 的 crumb 沒有它們，因為這兩件事在新的 sessions 清單裡已經被釘在最上面（P4）。**因此 P2 不可以先刪 badge**——必須等 P4 的釘選上線後才移除，否則中間會有一段版本讓使用者看不到跨 agent 的待辦。順序寫死：P4 先，P2 的移除動作最後做。

**驗收**：桌機同時看得到 rail + sessions + thread + changes；手機 crumb 是單列。

### P3 · 引擎讀數（agent · model · thinking level）
**檔案**：`components/Composer.tsx` 附近新增一個 dock、`components/ActionMenu.tsx`（重用選單邏輯）、`styles.css`

位置定案：**訊息窗格底部、輸入框之外、靠右一列**（28px）。跑動中顯示 spinner ＋ 計時，閒置時只剩設定本身。它同時是切換 model / thinking level 的入口。

資料都是現成的，不需要協定改動：

| 顯示 | 來源 |
|---|---|
| agent | `store.agentName` |
| model | `s.models.find(m => m.modelId === sess.modelId)?.name`（`types.ts:63,101,200`；`ActionMenu.tsx:35` 已經這樣取） |
| thinking level | `s.configOptions` 中 category/id/name 含 `reason` 或 `thought` 的那一個（`ActionMenu.tsx:9-14` 的 `configRank` 已用同一組關鍵字），值取 `currentValue`，選單取 `options[]` |
| 計時 | 既有的 turn 起算時間 |

注意事項：

- **顯示名稱一律用 `ConfigOption.name` / `Model.name` 回報的字**，不要自己造 `think:high` 這種字面（那只是 mock 的佔位）。claude 與 codex 的用詞不同。
- **不是每個 agent 都有 thinking level**（opencode 沒有）。沒有就整段不渲染，不要留 `—` 佔位。
- **換 model 會重建 effort 選項並可能夾住 mode**（`src/gateway.ts:2504` 有註解）。選單在換 model 後必須重讀 `configOptions`，不能快取。
- **P3 只顯示「現在的」值。** dock 與 turn label 都直接讀 store 的當前 model / effort。歷史快照（見 P7）不在這一階段。

**驗收**：working / idle 兩種狀態；切到 opencode 時 level 整段消失；換 model 後選單的 level 選項跟著更新。

### P4 · Sessions 兩種檢視
**檔案**：`components/Sidebar.tsx`、`store/store.ts`、`lib/api.ts`、`styles.css`

使用者可選，控制項在 panel header，用文字說出目前是哪個檢視（`folder ⌄` / `latest ⌄`），點開兩項選單。

1. **By folder**（預設）：資料夾為 header，帶 session 數與聚合狀態點；子列因此不再重複資料夾名，只留 agent，列高變矮。沒有東西在跑的資料夾預設收起。子列用 hairline spine 掛在資料夾下，active 標記在 spine 上。
   - 排序：**目前所在資料夾永遠第一**（你正在裡面工作，位置要穩定）→ 有東西等你 → 有東西在跑 → 依最近活動時間。
2. **Latest updated**：純時間序平面清單，**但 needs-you 與 running 釘在最上面**，用一行 `NEEDS YOU · RUNNING` 標籤 ＋ 一條 hairline 分隔。理由：等你按 Allow 的 session 不能因為安靜太久就沉下去，那正是你打開手機的原因。
3. 檢視選擇要持久化。`putTextSize`（`lib/api.ts:459`）是跨裝置共享的設定；**檢視偏好建議只存本機**（`localStorage`），因為手機和桌機想要的檢視通常不同。

**排序鍵 store 都有**：`session.working`（`types.ts:199`）、`inboxItems` / `pendingPermissions`（`store.ts:114-118`）、`updatedAt`。

> **最大的風險在這一階段，見 §4.1。**

### P5 · 手機：bottom tab bar
**檔案**：`App.tsx`、`styles.css`、`components/Sidebar.tsx`、`components/FilePanel.tsx`

手機不是把桌機三欄壓窄，而是把 icon rail 換成 bottom tab bar：`Chat / Changes / Sessions / Term`，Changes 帶變更檔數 badge。sidebar 與 FilePanel 從 overlay 改成 tab 的內容。crumb 維持單列。

**驗收**：safe-area inset 正確；四個 tab 都能切；`PendingPermissions` 的數量出現在 Sessions tab 的 badge 上（承接 P2 移除的 badge）。

### P6 · 清理
刪掉 P0–P5 過程中被取代的 CSS（舊的 `.msg.user .bubble`、`.blk`、agent-pill 相關規則等）。這一階段只刪，不加。用 `grep` 確認每一條要刪的 class 在 `web/src` 沒有剩餘引用再刪。

### P7 · （選配）turn label 的歷史快照
**這一階段是資料模型改動，不是樣式，所以獨立成一票，且不是 refactor 的必要條件。**

P3 之後，turn label 顯示的是「現在」的 model / level。若中途換過 model，捲上去看到的是新值而不是當時產生那則回覆的值。要做到真正的歷史記錄，必須在 assistant message item 上存下當下的 `modelId` 與 effort：

- `web/src/types.ts` 的 assistant item 型別加欄位（optional）
- store 建立 assistant item 的地方填值
- **從 history 載入的舊 session 沒有這些欄位**，所以要有 fallback：沒有快照時只渲染 agent 名稱，不渲染 `model · level`，不要顯示錯的值

沒有做 P7 也不影響 P0–P6 的完整性。

---

## 4. 風險

### 4.1 by-folder 分組的 cwd 正規化（高）

Sidebar 的清單是四個來源合併的：`runningTasks`（跨 agent）、`recentSessions`（本機快取）、`discovered`（CLI transcript 掃出來的）、以及伺服器端的 history 清單。`Sidebar.tsx:299` 已經明說：recents **不是** 以 cwd 為範圍的，因為「a recents row can spell the same folder differently than the gateway does」。

直接用 `cwd` 字串當 group key 會把同一個資料夾拆成好幾組。

**做法**：加一個 `folderKey(cwd)` 正規化函式（展開 `~`、去尾斜線、`path.resolve` 語意、macOS 大小寫不敏感），group key 用它，顯示用 `basename`。**先寫這個函式的單元測試，再寫 UI**，測資直接拿四個來源實際會產生的字串。

### 4.2 P2 與 P4 的順序（中）
如上所述，跨 agent 的 running / pending badge 在 P4 的釘選上線前不可移除。

### 4.3 collapse 狀態的持久化（低）
資料夾收合狀態若不記住，每次 poll 重繪都會彈回預設。存 `localStorage`，key 用 §4.1 的正規化路徑。

### 4.4 效能（低）
分組是 render 期間的純函式，資料量是既有清單大小（`RECENT_LIMIT` 已在限制）。用 `useMemo` 綁在來源陣列上即可，不需要新的 store 狀態。

---

## 5. 驗證

每個階段都要跑：

```bash
npm run typecheck              # 根目錄，tsc --noEmit
npm --prefix web run test      # vitest（web/src 下已有 App.test.ts、ActionMenu.test.ts 等）
npm --prefix web run typecheck
```

注意根目錄的 `npm test` 是 gateway 的 node test（`package.json` 裡帶了一長串 env 前綴），**不涵蓋 web 的改動**。web 的測試要用 `npm --prefix web run test`。

視覺驗收用實機：`make dev`，然後桌機與手機各看一次明暗兩色。不要只靠 jsdom 測試判定樣式正確。

**沒有互動式瀏覽器時的替代做法**（`agent-browser` 在這台機器上曾因 homebrew node 的 dyld 問題壞掉）：直接用 repo 裡已經裝好的 playwright 驅動無頭 Chromium。這是本次做 mockup 截圖時實際用的方式：

```js
// node /tmp/shot.mjs
import { chromium } from '<repo>/web/node_modules/playwright-core/index.mjs';
const b = await chromium.launch();
const p = await b.newPage({ viewportSize:{width:1700,height:1000}, deviceScaleFactor:2 });
await p.goto('http://localhost:<port>/');
await p.click('...');                       // 明暗要用「點按鈕」切，不要靠 prefers-color-scheme
await p.mouse.move(1690, 990);              // 把游標移開，否則截圖會殘留 :hover
await (await p.$('.content')).screenshot({ path:'/tmp/x.png' });  // 截元素，不要截整頁
await b.close();
```

要點：`deviceScaleFactor:2` 才看得清 hairline 與 mono 小字；截元素比截整頁有用；`data-theme` / `data-agent` 這類狀態用點擊切換再截。

P3 / P4 要補測試：

- `folderKey()` 的正規化單元測試（§4.1）
- latest 檢視的釘選排序：給定一筆 3 小時前但 needs-you 的 session，它必須排在 1 小時前的 idle session 之前
- thinking level 缺席時（opencode）dock 不渲染該段

## 6. PR 規範

`CLAUDE.md` 已寫死：每個 PR 都要同時對 `main` 與 `legacy/node20` 開（例如 `feat/foo` ＋ `feat/foo-node20`）。分階段上線代表會有 6 組 PR，不要合成一顆。

---

## 7. 交接 prompt

下一個 agent 直接貼這段：

````text
你要接手 cloud-acp-gateway 的 UI refactor。設計已經定案，不要重新設計，也不要提出替代方案。

先讀這三份，讀完再動手：
1. docs/ui-refactor-plan.md ← 設計契約與分階段計畫，這是唯一的規格來源
2. docs/ui-refactor/mockup-b2-quiet-console.html ← 視覺定稿。HTML 註解裡寫了每個決定的理由，照著做
3. docs/ui-refactor/F1-desktop-final-folder-view.png、F4-sessions-latest-updated.png、F5-mobile-final.png

這次只做 P0（Token 與顏色紀律），計畫書 §3 有完整範圍。做完停下來給我看，不要順手往 P1 做。

規則：
- 只改 web/src/styles.css 的 :root 區塊與 §3 P0 點名的那幾條規則。其他檔案一律不碰。
- 遵守 §1 的四條設計契約；遇到「這裡該用什麼顏色」的問題，答案在 §1.1 的表格裡，不要自己判斷。
- §2 是禁改清單，§2.1 精確劃出 Thread.tsx 的可動與不可動範圍——不是全檔禁改，但 structuralSig 與所有 effect 一字不動。
- mockup 裡的 think:high / opus-5 是假字串，不要照抄（§2.2）。
- 完成後跑 npm run typecheck 與 npm --prefix web run test（根目錄的 npm test 是 gateway 的測試，不涵蓋 web）。
- 視覺一定要真的看過：明暗兩色 × claude/codex/opencode 三種 agent。互動式瀏覽器不能用時，照 §5 的 playwright 無頭截圖做法，不要跳過。
- 回報時明確說：改了哪幾行、哪些視覺確認過、哪些沒確認。不要宣稱沒驗證過的東西是好的。

驗收條件（§3 P0）：畫面上的彩色只剩 permission 的 amber 與 diff 的紅綠；Allow / Send 在亮色是黑、暗色是白，且不隨 agent 變色。
````

之後每一階段沿用同一段，只換階段編號與驗收條件。**每次只給一個階段**——這份計畫是刻意切成可獨立上線的六塊，一次做完會失去逐步驗收的意義，也會讓 §4.2 的順序限制失效。
