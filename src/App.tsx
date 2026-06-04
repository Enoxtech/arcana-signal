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
  estimateArcMessageFee,
  fetchArcMessages,
  getChainModeLabel,
  getConfiguredContractModes,
  getContractModeLabel,
  hasContractConfig,
  hasEventReaderConfig,
  normalizeWalletAddress,
  submitArcMessage,
  type ArcFeeEstimate
} from "./chain";
import type { ContractMode, IntentMessage, MessageType } from "./types";

const STORAGE_KEY = "deararc:v2";
const WALLET_KEY = "deararc:wallet";
const messageTypes: MessageType[] = ["wish", "goal", "question", "thought"];
const messageTypeMeta: Record<MessageType, { label: string; note: string }> = {
  wish: { label: "Wish", note: "Desire" },
  goal: { label: "Goal", note: "Action" },
  question: { label: "Question", note: "Inquiry" },
  thought: { label: "Thought", note: "Pattern" }
};
const contractModeMeta: Record<
  ContractMode,
  { label: string; eyebrow: string; description: string; detail: string }
> = {
  signal: {
    label: "Signal",
    eyebrow: "Lowest fee",
    description: "Writes your message as an ARC event.",
    detail: "Arcana Signal retrieves it from permanent transaction logs."
  },
  archive: {
    label: "Archive",
    eyebrow: "Contract stored",
    description: "Stores your message in contract state and emits an ARC event.",
    detail: "Supports direct contract reads, with a higher network fee."
  }
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
  for (const message of current) byId.set(messageKey(message), message);
  for (const message of incoming) byId.set(messageKey(message), message);
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function messageKey(message: IntentMessage) {
  return normalizedText(message.txHash) || message.id;
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
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : fallback;

  if (
    /user rejected|user denied|request rejected|cancelled|canceled/i.test(
      message
    )
  ) {
    return "The wallet request was cancelled.";
  }
  if (/toLowerCase is not a function/i.test(message)) {
    return "The wallet returned an unsupported response. Refresh the wallet browser and try again.";
  }
  return message;
}

export default function App() {
  const [wallet, setWallet] = useState(
    () =>
      (import.meta.env.DEV
        ? new URLSearchParams(window.location.search).get("wallet")
        : null) ?? localStorage.getItem(WALLET_KEY)
  );
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
  const [isContractDialogOpen, setIsContractDialogOpen] = useState(false);
  const [selectedContractMode, setSelectedContractMode] =
    useState<ContractMode>("signal");
  const [feeEstimates, setFeeEstimates] = useState<
    Partial<Record<ContractMode, ArcFeeEstimate>>
  >({});
  const [feeEstimateErrors, setFeeEstimateErrors] = useState<
    Partial<Record<ContractMode, string>>
  >({});
  const [isEstimatingFees, setIsEstimatingFees] = useState(false);

  const chainMode = getChainModeLabel();
  const configuredContractModes = getConfiguredContractModes();

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
      const nextWallet = normalizeWalletAddress(args[0]);
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
    () => {
      if (!wallet) return [];
      const normalizedWallet = normalizedText(wallet);
      return messages.filter(
        (message) => normalizedText(message.sender) === normalizedWallet
      );
    },
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

  async function encodeMessage(contractMode?: ContractMode) {
    const cleanText = text.trim();
    const onchainMode = hasContractConfig();
    const sender = wallet ?? (onchainMode ? null : createDemoAddress());

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
            }, contractMode ?? configuredContractModes[0])
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
      txHash,
      contractMode
    };

    setMessages((current) => mergeMessages(current, [message]));
    setText("");
    setIntensity(3);
    setActiveId(message.id);
    setView("result");
    setIsContractDialogOpen(false);
    setIsSubmitting(false);
  }

  async function openContractDialog() {
    const cleanText = text.trim();
    if (!wallet || !cleanText) return;

    const preferredMode = configuredContractModes.includes("signal")
      ? "signal"
      : configuredContractModes[0];
    if (preferredMode) setSelectedContractMode(preferredMode);

    setSubmitError("");
    setFeeEstimates({});
    setFeeEstimateErrors({});
    setIsContractDialogOpen(true);
    setIsEstimatingFees(true);

    const results = await Promise.all(
      configuredContractModes.map(async (mode) => {
        try {
          const estimate = await estimateArcMessageFee(
            {
              from: wallet,
              text: cleanText,
              type,
              intensity
            },
            mode
          );
          return { mode, estimate };
        } catch (error) {
          return {
            mode,
            error: getErrorMessage(error, "Fee estimate unavailable.")
          };
        }
      })
    );

    const nextEstimates: Partial<Record<ContractMode, ArcFeeEstimate>> = {};
    const nextErrors: Partial<Record<ContractMode, string>> = {};
    for (const result of results) {
      if ("estimate" in result) nextEstimates[result.mode] = result.estimate;
      if ("error" in result) nextErrors[result.mode] = result.error;
    }
    setFeeEstimates(nextEstimates);
    setFeeEstimateErrors(nextErrors);
    setIsEstimatingFees(false);
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

    if (onchainMode && configuredContractModes.length > 1) {
      await openContractDialog();
      return;
    }

    await encodeMessage(configuredContractModes[0]);
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

      {isContractDialogOpen && (
        <ContractChoiceDialog
          modes={configuredContractModes}
          selectedMode={selectedContractMode}
          estimates={feeEstimates}
          estimateErrors={feeEstimateErrors}
          isEstimating={isEstimatingFees}
          isSubmitting={isSubmitting}
          submitError={submitError}
          onSelect={setSelectedContractMode}
          onClose={() => {
            if (!isSubmitting) setIsContractDialogOpen(false);
          }}
          onConfirm={() => encodeMessage(selectedContractMode)}
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
          <span>{getContractModeLabel(message.contractMode)} txHash</span>
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
                    <span className="timeline-labels">
                      <span className="timeline-type">
                        {formatType(message.type)}
                      </span>
                      <span className={`record-type ${message.contractMode ?? "local"}`}>
                        {getContractModeLabel(message.contractMode)}
                      </span>
                    </span>
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

function ContractChoiceDialog({
  modes,
  selectedMode,
  estimates,
  estimateErrors,
  isEstimating,
  isSubmitting,
  submitError,
  onSelect,
  onClose,
  onConfirm
}: {
  modes: ContractMode[];
  selectedMode: ContractMode;
  estimates: Partial<Record<ContractMode, ArcFeeEstimate>>;
  estimateErrors: Partial<Record<ContractMode, string>>;
  isEstimating: boolean;
  isSubmitting: boolean;
  submitError: string;
  onSelect: (mode: ContractMode) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="contract-dialog surface-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contract-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span>ARC transaction</span>
            <h2 id="contract-dialog-title">Choose how to preserve this message</h2>
          </div>
          <button type="button" onClick={onClose} disabled={isSubmitting}>
            Close
          </button>
        </div>

        <div className="contract-options">
          {modes.map((mode) => {
            const meta = contractModeMeta[mode];
            const estimate = estimates[mode];
            const estimateError = estimateErrors[mode];
            return (
              <button
                className={`contract-option ${
                  selectedMode === mode ? "selected" : ""
                }`}
                type="button"
                key={mode}
                onClick={() => onSelect(mode)}
                disabled={isSubmitting}
                aria-pressed={selectedMode === mode}
              >
                <span className="contract-option-top">
                  <span>
                    <strong>{meta.label}</strong>
                    {mode === "signal" && <em>Recommended</em>}
                  </span>
                  <small>{meta.eyebrow}</small>
                </span>
                <span className="contract-description">{meta.description}</span>
                <span className="contract-detail">{meta.detail}</span>
                <span className="fee-row">
                  <span>
                    <small>Estimated network fee</small>
                    <strong>
                      {isEstimating
                        ? "Estimating..."
                        : estimate
                          ? formatFeeEstimate(estimate)
                          : "Unavailable"}
                    </strong>
                  </span>
                  <span>
                    <small>Gas units</small>
                    <strong>
                      {estimate ? estimate.gasUnits.toLocaleString() : "-"}
                    </strong>
                  </span>
                </span>
                {estimateError && (
                  <span className="fee-error">{estimateError}</span>
                )}
              </button>
            );
          })}
        </div>

        <p className="dialog-note">
          Both choices remain onchain and appear in your Arcana Signal history.
          Your wallet shows the final fee before approval.
        </p>
        {submitError && <p className="submit-error">{submitError}</p>}
        <div className="action-row dialog-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting || isEstimating || !estimates[selectedMode]}
          >
            {isSubmitting
              ? "Confirming on ARC..."
              : `Use ${contractModeMeta[selectedMode].label}`}
          </button>
        </div>
      </section>
    </div>
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

function formatFeeEstimate(estimate: ArcFeeEstimate) {
  const value = Number(estimate.formattedFee);
  const formatted = Number.isFinite(value)
    ? value.toLocaleString(undefined, {
        minimumFractionDigits: value > 0 && value < 0.001 ? 6 : 4,
        maximumFractionDigits: 6
      })
    : estimate.formattedFee;
  return `${formatted} ${estimate.symbol}`;
}
