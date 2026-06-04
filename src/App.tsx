import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  buildWalletProfile,
  compactAddress,
  createTxHash,
  formatType,
  interpretMessage
} from "./stateEngine";
import {
  connectArcWallet,
  fetchArcMessages,
  getChainModeLabel,
  hasContractConfig,
  hasEventReaderConfig,
  submitArcMessage
} from "./chain";
import type { IntentMessage, MessageType } from "./types";

const STORAGE_KEY = "deararc:v2";
const WALLET_KEY = "deararc:wallet";
const messageTypes: MessageType[] = ["wish", "goal", "question", "thought"];
const messageTypeMeta: Record<MessageType, { label: string; note: string }> = {
  wish: { label: "Wish", note: "Desire" },
  goal: { label: "Goal", note: "Action" },
  question: { label: "Question", note: "Inquiry" },
  thought: { label: "Thought", note: "Pattern" }
};

type View = "write" | "result" | "profile";

function loadMessages() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as IntentMessage[]) : [];
  } catch {
    return [];
  }
}

function saveMessages(messages: IntentMessage[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
}

function mergeMessages(current: IntentMessage[], incoming: IntentMessage[]) {
  const byId = new Map<string, IntentMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function createDemoAddress() {
  const existing = localStorage.getItem(WALLET_KEY);
  if (existing) return existing;
  const random = crypto.getRandomValues(new Uint8Array(20));
  const address = `arc1${[...random]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 38)}`;
  localStorage.setItem(WALLET_KEY, address);
  return address;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

export default function App() {
  const [wallet, setWallet] = useState(() => localStorage.getItem(WALLET_KEY));
  const [messages, setMessages] = useState<IntentMessage[]>(loadMessages);
  const [text, setText] = useState("");
  const [type, setType] = useState<MessageType>("wish");
  const [intensity, setIntensity] = useState(3);
  const [view, setView] = useState<View>("write");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isSyncingHistory, setIsSyncingHistory] = useState(false);
  const [syncError, setSyncError] = useState("");

  const chainMode = getChainModeLabel();

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  useEffect(() => {
    if (wallet) {
      localStorage.setItem(WALLET_KEY, wallet);
    }
  }, [wallet]);

  useEffect(() => {
    if (!window.ethereum?.on) return;

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      const nextWallet = accounts?.[0] ?? null;
      setWallet(nextWallet);

      if (!nextWallet) {
        localStorage.removeItem(WALLET_KEY);
        setView("write");
      }
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
    };
  }, []);

  useEffect(() => {
    if (!wallet || !hasEventReaderConfig()) return;

    let cancelled = false;

    async function syncHistory() {
      setIsSyncingHistory(true);
      setSyncError("");

      try {
        const onchainMessages = await fetchArcMessages(wallet ?? undefined);
        if (!cancelled) {
          setMessages((current) => mergeMessages(current, onchainMessages));
        }
      } catch (error) {
        if (!cancelled) {
          setSyncError(
            error instanceof Error
              ? error.message
              : "Could not read ARC message events."
          );
        }
      } finally {
        if (!cancelled) {
          setIsSyncingHistory(false);
        }
      }
    }

    syncHistory();

    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const walletMessages = useMemo(
    () => messages.filter((message) => message.sender === wallet),
    [messages, wallet]
  );

  const profile = useMemo(
    () => buildWalletProfile(walletMessages),
    [walletMessages]
  );

  const activeMessage = useMemo(() => {
    if (!activeId) return walletMessages[0] ?? null;
    return walletMessages.find((message) => message.id === activeId) ?? null;
  }, [activeId, walletMessages]);

  const activeReport = useMemo(
    () => (activeMessage ? interpretMessage(activeMessage) : null),
    [activeMessage]
  );

  async function connectWallet() {
    setSubmitError("");

    try {
      setWallet(await connectArcWallet());
    } catch (error) {
      setSubmitError(
        getErrorMessage(error, "The wallet could not be connected.")
      );
    }
  }

  function disconnectWallet() {
    setWallet(null);
    localStorage.removeItem(WALLET_KEY);
    setView("write");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanText = text.trim();
    const onchainMode = hasContractConfig();
    const sender = wallet ?? (onchainMode ? null : createDemoAddress());
    setSubmitError("");

    if (!cleanText || isSubmitting) return;

    if (!sender || (onchainMode && !sender.startsWith("0x"))) {
      setSubmitError("Connect an EVM wallet before encoding an onchain state.");
      return;
    }

    setWallet(sender);
    setIsSubmitting(true);
    const timestamp = Date.now();
    const nonce = messages.length + 1;
    let txHash: string;

    try {
      txHash =
        onchainMode
          ? await submitArcMessage({
              from: sender,
              text: cleanText,
              type,
              intensity
            })
          : await createTxHash({
              sender,
              text: cleanText,
              type,
              intensity,
              timestamp,
              nonce
            });
    } catch (error) {
      setSubmitError(
        getErrorMessage(error, "The ARC transaction could not be submitted.")
      );
      setIsSubmitting(false);
      return;
    }

    const message: IntentMessage = {
      id: `${timestamp}-${nonce}`,
      sender,
      text: cleanText,
      type,
      intensity,
      timestamp,
      txHash
    };

    setMessages((current) => [message, ...current]);
    setText("");
    setIntensity(3);
    setActiveId(message.id);
    setView("result");
    setIsSubmitting(false);
  }

  return (
    <main className="app-shell">
      <div className="cosmos" aria-hidden="true" />
      <div className="aurora" aria-hidden="true" />
      <header className="top-bar">
        <div className="brand-lockup" aria-label="Arcana Signal">
          <span className="brand-mark" />
          <div>
            <strong>Arcana Signal</strong>
            <span>DearARC v2</span>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Arcana Signal views">
          {(["write", "result", "profile"] as const).map((item) => (
            <button
              key={item}
              className={view === item ? "active" : ""}
              type="button"
              onClick={() => setView(item)}
              disabled={item === "result" && !activeMessage}
            >
              {item}
            </button>
          ))}
        </nav>

        <button
          className="wallet-button"
          type="button"
          onClick={wallet ? disconnectWallet : connectWallet}
        >
          {wallet ? "Disconnect" : "Connect"}
        </button>
      </header>

      <section className="hero">
        <div className="signal-orb" aria-hidden="true">
          <span className="orb-core" />
          <span className="orb-ring ring-one" />
          <span className="orb-ring ring-two" />
        </div>
        <p className="overline">Arcana</p>
        <h1>Signal</h1>
        <p className="signal-title">ONCHAIN INTENTION STATE</p>
        <p className="signal-copy">Deterministic feedback for ARC wallets</p>
        <div className="status-row">
          {wallet && (
            <div className="address-pill">
              <span />
              {compactAddress(wallet)}
            </div>
          )}
          <div className="mode-pill">
            <span />
            {isSyncingHistory ? "Syncing ARC events" : chainMode}
          </div>
        </div>
        {syncError && <p className="sync-error">{syncError}</p>}
      </section>

      {view === "write" && (
        <WritePanel
          text={text}
          type={type}
          intensity={intensity}
          isSubmitting={isSubmitting}
          hasWallet={Boolean(wallet)}
          requiresWallet={hasContractConfig()}
          onConnect={connectWallet}
          onText={setText}
          onType={setType}
          onIntensity={setIntensity}
          onSubmit={handleSubmit}
          submitError={submitError}
        />
      )}

      {view === "result" && (
        <ResultPanel
          message={activeMessage}
          report={activeReport}
          profileTotal={profile.total}
          executionBias={profile.executionBias}
          dominantType={profile.dominantType}
          onWrite={() => setView("write")}
          onProfile={() => setView("profile")}
        />
      )}

      {view === "profile" && (
        <ProfilePanel
          messages={walletMessages}
          profile={profile}
          chainMode={chainMode}
          isSyncingHistory={isSyncingHistory}
          onSelect={(message) => {
            setActiveId(message.id);
            setView("result");
          }}
        />
      )}
    </main>
  );
}

interface WritePanelProps {
  text: string;
  type: MessageType;
  intensity: number;
  isSubmitting: boolean;
  hasWallet: boolean;
  requiresWallet: boolean;
  onConnect: () => void;
  onText: (value: string) => void;
  onType: (type: MessageType) => void;
  onIntensity: (value: number) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  submitError: string;
}

function WritePanel(props: WritePanelProps) {
  return (
    <form className="message-panel surface-in" onSubmit={props.onSubmit}>
      <div className="panel-heading">
        <span>Your message to the protocol</span>
        <strong>{props.intensity}/5</strong>
      </div>

      <textarea
        value={props.text}
        onChange={(event) => props.onText(event.target.value)}
        placeholder="I want to turn this intention into a clear state..."
        maxLength={260}
      />

      <div className="type-grid" aria-label="Message type">
        {messageTypes.map((item) => (
          <button
            key={item}
            className={props.type === item ? "selected" : ""}
            type="button"
            onClick={() => props.onType(item)}
          >
            <strong>{messageTypeMeta[item].label}</strong>
            <span>{messageTypeMeta[item].note}</span>
          </button>
        ))}
      </div>

      <label className="intensity-row">
        <span>Intensity</span>
        <input
          type="range"
          min="1"
          max="5"
          step="1"
          value={props.intensity}
          onChange={(event) => props.onIntensity(Number(event.target.value))}
        />
        <span>{intensityLabel(props.intensity)}</span>
      </label>

      <div className="action-row">
        {!props.hasWallet && (
          <button className="ghost-button" type="button" onClick={props.onConnect}>
            Connect wallet
          </button>
        )}
        <button
          className="primary-button"
          type="submit"
          disabled={
            !props.text.trim() ||
            props.isSubmitting ||
            (props.requiresWallet && !props.hasWallet)
          }
        >
          {props.isSubmitting ? "Confirming on ARC..." : "Encode state"}
        </button>
      </div>
      {props.submitError && <p className="submit-error">{props.submitError}</p>}
    </form>
  );
}

function ResultPanel({
  message,
  report,
  profileTotal,
  executionBias,
  dominantType,
  onWrite,
  onProfile
}: {
  message: IntentMessage | null;
  report: ReturnType<typeof interpretMessage> | null;
  profileTotal: number;
  executionBias: string;
  dominantType: MessageType | "none";
  onWrite: () => void;
  onProfile: () => void;
}) {
  if (!message || !report) {
    return (
      <section className="empty-state surface-in">
        <p>No encoded state yet.</p>
        <button className="primary-button" type="button" onClick={onWrite}>
          Write message
        </button>
      </section>
    );
  }

  return (
    <section className="result-layout surface-in">
      <article className="state-card">
        <div className="panel-heading">
          <span>State report</span>
          <strong>{formatType(message.type)}</strong>
        </div>
        <div className="state-orb-mini" aria-hidden="true">
          <span />
        </div>
        <div className="tx-line">
          <span>txHash</span>
          <code>{compactAddress(message.txHash, 10, 10)}</code>
        </div>
        <div className="state-grid">
          <Metric label="Intent" value={report.vector.intent} />
          <Metric label="Execution" value={report.vector.execution} />
          <Metric label="Tone" value={report.vector.tone} />
        </div>
      </article>

      <article className="reflection-card">
        <h2>Reflection</h2>
        <p>{report.reflection}</p>
        <h2>Next signal</h2>
        <p>{report.nextSignal}</p>
      </article>

      <article className="trend-card">
        <div>
          <span className="meta-label">Wallet trend</span>
          <strong>
            {profileTotal} {profileTotal === 1 ? "entry" : "entries"}
          </strong>
        </div>
        <div>
          <span className="meta-label">Dominant</span>
          <strong>
            {dominantType === "none" ? "None" : `${formatType(dominantType)}-driven`}
          </strong>
        </div>
        <div>
          <span className="meta-label">Execution bias</span>
          <strong>{executionBias}</strong>
        </div>
      </article>

      <div className="action-row result-actions">
        <button className="ghost-button" type="button" onClick={onWrite}>
          Write another
        </button>
        <button className="primary-button" type="button" onClick={onProfile}>
          View profile
        </button>
      </div>
    </section>
  );
}

function ProfilePanel({
  messages,
  profile,
  chainMode,
  isSyncingHistory,
  onSelect
}: {
  messages: IntentMessage[];
  profile: ReturnType<typeof buildWalletProfile>;
  chainMode: string;
  isSyncingHistory: boolean;
  onSelect: (message: IntentMessage) => void;
}) {
  return (
    <section className="profile-layout surface-in">
      <article className="profile-card">
        <div className="panel-heading">
          <span>Wallet state</span>
          <strong>{profile.total}</strong>
        </div>
        <div className="profile-source">
          <span>{isSyncingHistory ? "Syncing profile" : chainMode}</span>
        </div>

        <div className="profile-metrics">
          <Metric
            label="Average intensity"
            value={profile.averageIntensity ? profile.averageIntensity.toFixed(1) : "0.0"}
          />
          <Metric
            label="Dominant behavior"
            value={
              profile.dominantType === "none"
                ? "None"
                : `${formatType(profile.dominantType)}-driven`
            }
          />
          <Metric label="Execution bias" value={profile.executionBias} />
        </div>

        <div className="bias-meter" aria-label="Execution bias score">
          <span style={{ width: `${profile.executionBiasScore}%` }} />
        </div>

        <p className="pattern-copy">{profile.pattern}</p>

        <div className="type-bars">
          {messageTypes.map((item) => (
            <div className="type-bar" key={item}>
              <span>{formatType(item)}</span>
              <div>
                <span style={{ width: `${profile.typePercentages[item]}%` }} />
              </div>
              <strong>{profile.typePercentages[item]}%</strong>
            </div>
          ))}
        </div>
      </article>

      <article className="timeline-card">
        <div className="panel-heading">
          <span>History timeline</span>
          <strong>{messages.length}</strong>
        </div>
        {messages.length === 0 ? (
          <p className="empty-copy">No messages encoded for this wallet.</p>
        ) : (
          <ol className="timeline">
            {messages.map((message) => {
              const report = interpretMessage(message);
              return (
                <li key={message.id}>
                  <button type="button" onClick={() => onSelect(message)}>
                    <span className="timeline-type">{formatType(message.type)}</span>
                    <strong>{message.text}</strong>
                    <small>
                      {report.vector.intent} / {report.vector.execution} /{" "}
                      {report.vector.tone}
                    </small>
                    <time>{new Date(message.timestamp).toLocaleString()}</time>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </article>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function intensityLabel(value: number) {
  if (value <= 1) return "Low";
  if (value === 2) return "Soft";
  if (value === 3) return "Clear";
  if (value === 4) return "High";
  return "Maximum";
}
