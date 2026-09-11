"use client";

import { useEffect, useMemo, useState } from "react";

const THEME_KEY = "stt-theme";
const USAGE_KEY = "stt-usage-v1";
const BALANCE_KEY = "stt-balance-v1";

type ThemeMode = "light" | "dark" | "system";

type UsageEntry = {
  id: string;
  createdAt: string;
  fileName: string;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd: number;
};

type BalanceSnapshot = {
  amount: number;
  setAt: string;
};

function applyTheme(mode: ThemeMode) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function money(value: number, compact = false) {
  if (compact && value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(2)}`;
}

function number(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function loadUsage(): UsageEntry[] {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadBalance(): BalanceSnapshot | null {
  try {
    const raw = localStorage.getItem(BALANCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.amount !== "number" || typeof parsed?.setAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export default function UsagePage() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [entries, setEntries] = useState<UsageEntry[]>([]);
  const [balance, setBalance] = useState<BalanceSnapshot | null>(null);
  const [balanceInput, setBalanceInput] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    const initial: ThemeMode = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    setTheme(initial);
    applyTheme(initial);
    setEntries(loadUsage());
    const storedBalance = loadBalance();
    setBalance(storedBalance);
    if (storedBalance) setBalanceInput(String(storedBalance.amount));

    const sync = () => setEntries(loadUsage());
    window.addEventListener("storage", sync);
    window.addEventListener("stt-usage-updated", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("stt-usage-updated", sync);
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);

    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  const totals = useMemo(() => {
    return entries.reduce(
      (acc, entry) => ({
        requests: acc.requests + 1,
        inputTokens: acc.inputTokens + (entry.inputTokens || 0),
        outputTokens: acc.outputTokens + (entry.outputTokens || 0) + (entry.thoughtTokens || 0),
        totalTokens: acc.totalTokens + (entry.totalTokens || 0),
        spend: acc.spend + (entry.costUsd || 0),
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, spend: 0 },
    );
  }, [entries]);

  const spendSinceBalance = useMemo(() => {
    if (!balance) return 0;
    const start = new Date(balance.setAt).getTime();
    return entries.reduce((sum, entry) => {
      const created = new Date(entry.createdAt).getTime();
      return created >= start ? sum + (entry.costUsd || 0) : sum;
    }, 0);
  }, [entries, balance]);

  const remaining = balance ? Math.max(balance.amount - spendSinceBalance, 0) : null;
  const usedPercent = balance && balance.amount > 0
    ? Math.min(100, (spendSinceBalance / balance.amount) * 100)
    : 0;

  function saveBalance() {
    const amount = Number(balanceInput);
    if (!Number.isFinite(amount) || amount < 0) return;
    const next = { amount, setAt: new Date().toISOString() };
    localStorage.setItem(BALANCE_KEY, JSON.stringify(next));
    setBalance(next);
  }

  function clearHistory() {
    if (!window.confirm("Clear the locally tracked usage history?")) return;
    localStorage.removeItem(USAGE_KEY);
    setEntries([]);
  }

  const recent = [...entries].reverse().slice(0, 20);

  return (
    <main className="shell usageShell">
      <header className="topbar">
        <div className="brandArea">
          <div className="brand">Speech to Text</div>
        </div>

        <div className="topbarActions">
          <nav className="pageNav" aria-label="Pages">
            <a className="navLink" href="/">Transcribe</a>
            <a className="navLink active" href="/usage">Usage</a>
          </nav>
          <div className="themeSwitch" role="group" aria-label="Color theme">
            {(["light", "dark", "system"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? "active" : ""}
                aria-pressed={theme === mode}
                onClick={() => setTheme(mode)}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="intro usageIntro">
        <h1>Usage</h1>
        <p>Cost and token usage from successful transcriptions made in this browser.</p>
      </section>

      <section className="usageGrid">
        <article className="metricCard">
          <span>Tracked spend</span>
          <strong>{money(totals.spend, true)}</strong>
          <small>Since usage tracking started</small>
        </article>
        <article className="metricCard">
          <span>Requests</span>
          <strong>{number(totals.requests)}</strong>
          <small>Successful transcriptions</small>
        </article>
        <article className="metricCard">
          <span>Input tokens</span>
          <strong>{number(totals.inputTokens)}</strong>
          <small>Audio input</small>
        </article>
        <article className="metricCard">
          <span>Output tokens</span>
          <strong>{number(totals.outputTokens)}</strong>
          <small>Text output</small>
        </article>
      </section>

      <section className="usageColumns">
        <article className="usagePanel balancePanel">
          <div className="usagePanelHeader">
            <div>
              <span className="resultLabel">Balance tracker</span>
              <h2>{remaining === null ? "Set your current balance" : `${money(remaining)} remaining`}</h2>
            </div>
          </div>

          <div className="balanceProgress" aria-label="Tracked balance used">
            <span style={{ width: `${usedPercent}%` }} />
          </div>

          <div className="balanceStats">
            <div><span>Starting snapshot</span><strong>{balance ? money(balance.amount) : "—"}</strong></div>
            <div><span>Spent since snapshot</span><strong>{balance ? money(spendSinceBalance, true) : "—"}</strong></div>
          </div>

          <div className="balanceForm">
            <label htmlFor="balance">Current available credit</label>
            <div>
              <span>$</span>
              <input
                id="balance"
                inputMode="decimal"
                type="number"
                min="0"
                step="0.01"
                placeholder="4.90"
                value={balanceInput}
                onChange={(event) => setBalanceInput(event.target.value)}
              />
              <button type="button" onClick={saveBalance}>Set from now</button>
            </div>
          </div>

          <p className="usageNote">
            Set this to the official available credit shown in your billing account. From that moment, this page subtracts the exact tracked cost of this app's successful requests.
          </p>
        </article>

        <article className="usagePanel pricingPanel">
          <div className="usagePanelHeader">
            <div>
              <span className="resultLabel">Cost basis</span>
              <h2>Current transcription pricing</h2>
            </div>
          </div>
          <div className="pricingRows">
            <div><span>Input</span><strong>$2.00 / 1M tokens</strong></div>
            <div><span>Output</span><strong>$12.00 / 1M tokens</strong></div>
            <div><span>Typical combined rate</span><strong>≈ $0.005 / min</strong></div>
          </div>
          <p className="usageNote">
            Request cost is calculated from the token usage returned by the transcription API. The per-minute figure is only a pricing reference.
          </p>
        </article>
      </section>

      <section className="usagePanel historyPanel">
        <div className="usagePanelHeader historyHeader">
          <div>
            <span className="resultLabel">History</span>
            <h2>Recent requests</h2>
          </div>
          {entries.length > 0 && <button className="secondaryButton" type="button" onClick={clearHistory}>Clear local history</button>}
        </div>

        {recent.length ? (
          <div className="usageTableWrap">
            <table className="usageTable">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Time</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((entry) => (
                  <tr key={entry.id}>
                    <td title={entry.fileName}>{entry.fileName}</td>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>{number(entry.inputTokens)}</td>
                    <td>{number(entry.outputTokens + entry.thoughtTokens)}</td>
                    <td>{money(entry.costUsd, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="usageEmpty">No tracked requests yet. New successful transcriptions will appear here.</div>
        )}
      </section>

      <p className="usageDisclaimer">
        This is an app-level tracker stored in this browser. It cannot read the provider's authoritative prepaid balance, other apps' usage, or activity from another device.
      </p>
    </main>
  );
}
