import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseAbiItem,
  toHex,
  type Chain
} from "viem";
import type { ContractMode, IntentMessage, MessageType } from "./types";

const messageTypeIndex: Record<MessageType, number> = {
  wish: 0,
  goal: 1,
  question: 2,
  thought: 3
};

const messageTypeFromIndex = ["wish", "goal", "question", "thought"] as const;

const dearArcAbi = [
  {
    type: "function",
    name: "createMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "text", type: "string" },
      { name: "messageType", type: "uint8" },
      { name: "intensity", type: "uint8" }
    ],
    outputs: []
  }
] as const;

const messageCreatedEvent = parseAbiItem(
  "event MessageCreated(address indexed sender, string text, uint8 messageType, uint8 intensity, uint256 timestamp)"
);

const signalContractAddress = (
  import.meta.env.VITE_DEARARC_SIGNAL_CONTRACT_ADDRESS ||
  import.meta.env.VITE_DEARARC_CONTRACT_ADDRESS
) as `0x${string}` | undefined;
const archiveContractAddress = import.meta.env
  .VITE_DEARARC_ARCHIVE_CONTRACT_ADDRESS as `0x${string}` | undefined;
const signalDeployBlock =
  import.meta.env.VITE_DEARARC_SIGNAL_DEPLOY_BLOCK ||
  import.meta.env.VITE_DEARARC_DEPLOY_BLOCK;
const archiveDeployBlock = import.meta.env.VITE_DEARARC_ARCHIVE_DEPLOY_BLOCK;

const contractConfig: Record<
  ContractMode,
  { address?: `0x${string}`; deployBlock?: string }
> = {
  signal: {
    address: signalContractAddress,
    deployBlock: signalDeployBlock
  },
  archive: {
    address: archiveContractAddress,
    deployBlock: archiveDeployBlock
  }
};

const arcChainId = import.meta.env.VITE_ARC_CHAIN_ID as string | undefined;
const arcRpcUrl = import.meta.env.VITE_ARC_RPC_URL as string | undefined;
const arcChainName = import.meta.env.VITE_ARC_CHAIN_NAME || "ARC Testnet";
const arcCurrencyName = import.meta.env.VITE_ARC_NATIVE_CURRENCY_NAME || "USDC";
const arcCurrencySymbol =
  import.meta.env.VITE_ARC_NATIVE_CURRENCY_SYMBOL || "USDC";
const arcExplorerUrl = import.meta.env.VITE_ARC_BLOCK_EXPLORER_URL as
  | string
  | undefined;

export interface ArcFeeEstimate {
  gasUnits: bigint;
  feeWei: bigint;
  formattedFee: string;
  balanceWei: bigint;
  formattedBalance: string;
  hasSufficientBalance: boolean;
  symbol: string;
}

export interface ArcWalletConnection {
  account: string;
  chainReady: boolean;
  warning?: string;
}

type ProviderRecord = Record<string, unknown>;
export const ARC_FAUCET_URL = "https://faucet.circle.com/";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (
        event: string,
        listener: (...args: unknown[]) => void
      ) => void;
    };
  }
}

function asProviderRecord(value: unknown): ProviderRecord | null {
  return typeof value === "object" && value !== null
    ? (value as ProviderRecord)
    : null;
}

function nestedProviderValues(value: unknown, keys: string[]) {
  const record = asProviderRecord(value);
  if (!record) return [];
  return keys.map((key) => record[key]).filter((item) => item !== undefined);
}

export function normalizeWalletAddress(
  value: unknown,
  depth = 0
): string | null {
  if (depth > 3) return null;

  if (typeof value === "string") {
    const address = value.trim();
    return isAddress(address) ? address : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const address = normalizeWalletAddress(item, depth + 1);
      if (address) return address;
    }
    return null;
  }

  for (const item of nestedProviderValues(value, [
    "address",
    "account",
    "selectedAddress",
    "accounts",
    "result",
    "value"
  ])) {
    const address = normalizeWalletAddress(item, depth + 1);
    if (address) return address;
  }

  return null;
}

export function normalizeProviderChainId(
  value: unknown,
  depth = 0
): string | null {
  if (depth > 3) return null;

  try {
    if (typeof value === "bigint") {
      return value >= 0n ? `0x${value.toString(16)}` : null;
    }

    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0
        ? `0x${value.toString(16)}`
        : null;
    }

    if (typeof value === "string") {
      const chainId = value.trim();
      if (/^0x[0-9a-f]+$/i.test(chainId)) {
        return `0x${BigInt(chainId).toString(16)}`;
      }
      if (/^\d+$/.test(chainId)) {
        return `0x${BigInt(chainId).toString(16)}`;
      }
      const caipChainId = /^eip155:(\d+)$/i.exec(chainId)?.[1];
      if (caipChainId) {
        return `0x${BigInt(caipChainId).toString(16)}`;
      }
      return null;
    }
  } catch {
    return null;
  }

  for (const item of nestedProviderValues(value, [
    "chainId",
    "chainID",
    "id",
    "result",
    "value"
  ])) {
    const chainId = normalizeProviderChainId(item, depth + 1);
    if (chainId) return chainId;
  }

  return null;
}

export function normalizeTransactionHash(
  value: unknown,
  depth = 0
): `0x${string}` | null {
  if (depth > 3) return null;

  if (typeof value === "string") {
    const hash = value.trim();
    return /^0x[0-9a-f]{64}$/i.test(hash) ? (hash as `0x${string}`) : null;
  }

  for (const item of nestedProviderValues(value, [
    "hash",
    "txHash",
    "transactionHash",
    "result",
    "value"
  ])) {
    const hash = normalizeTransactionHash(item, depth + 1);
    if (hash) return hash;
  }

  return null;
}

function providerErrorCode(error: unknown, depth = 0): number {
  if (depth > 3) return 0;
  const record = asProviderRecord(error);
  if (!record) return 0;

  for (const item of nestedProviderValues(error, [
    "data",
    "error",
    "originalError",
    "cause"
  ])) {
    const nestedCode = providerErrorCode(item, depth + 1);
    if (nestedCode) return nestedCode;
  }

  const code = Number(record.code);
  return Number.isFinite(code) && code !== 0 ? code : 0;
}

export function getProviderErrorMessage(
  error: unknown,
  depth = 0
): string | null {
  if (depth > 4) return null;

  if (typeof error === "string" && error.trim()) return error.trim();

  const record = asProviderRecord(error);
  if (!record) {
    return error instanceof Error && error.message ? error.message : null;
  }

  for (const item of nestedProviderValues(error, [
    "data",
    "error",
    "originalError",
    "cause",
    "result"
  ])) {
    const message = getProviderErrorMessage(item, depth + 1);
    if (message && !/internal json-rpc error/i.test(message)) return message;
  }

  if (error instanceof Error && error.message) return error.message;

  for (const key of ["message", "shortMessage", "details", "reason"]) {
    const message = record[key];
    if (typeof message === "string" && message.trim()) return message.trim();
  }

  return null;
}

function friendlyProviderMessage(error: unknown, fallback: string) {
  const message = getProviderErrorMessage(error) ?? fallback;

  if (/no assets found/i.test(message)) {
    return "Trust Wallet could not find the ARC Testnet USDC gas asset. Fund this address with ARC Testnet USDC, then retry. If the balance is already funded, use an ARC-compatible wallet such as MetaMask, Rabby, Coinbase Wallet, or Rainbow.";
  }
  if (
    /user rejected|user denied|user refused|request rejected|cancelled|canceled/i.test(
      message
    )
  ) {
    return "The wallet request was cancelled.";
  }
  if (/insufficient funds|insufficient balance/i.test(message)) {
    return "This wallet does not have enough ARC Testnet USDC to pay the network fee.";
  }
  return message;
}

function isConfiguredMode(mode: ContractMode) {
  const address = contractConfig[mode].address;
  return Boolean(address && isAddress(address));
}

export function getConfiguredContractModes(): ContractMode[] {
  return (["signal", "archive"] as const).filter(isConfiguredMode);
}

export function getContractModeLabel(mode?: ContractMode) {
  if (mode === "archive") return "Archive record";
  if (mode === "signal") return "Signal record";
  return "Local record";
}

export function hasContractConfig() {
  return getConfiguredContractModes().length > 0;
}

export function hasEventReaderConfig() {
  return Boolean(hasContractConfig() && arcRpcUrl && arcChainId);
}

export function getChainModeLabel() {
  if (hasEventReaderConfig() && getConfiguredContractModes().length > 1) {
    return "Dual-contract event mode";
  }
  if (hasEventReaderConfig()) return "Onchain event mode";
  if (hasContractConfig()) return "Write-only chain mode";
  return "Local deterministic mode";
}

function parseChainId(value: string) {
  const normalized = normalizeProviderChainId(value);
  return normalized ? Number.parseInt(normalized.slice(2), 16) : 0;
}

function chainIdHex(value: string) {
  return (
    normalizeProviderChainId(value) ?? `0x${parseChainId(value).toString(16)}`
  );
}

function getArcChain(): Chain {
  const id = arcChainId ? parseChainId(arcChainId) : 0;

  return {
    id,
    name: arcChainName,
    nativeCurrency: {
      decimals: 18,
      name: arcCurrencyName,
      symbol: arcCurrencySymbol
    },
    rpcUrls: {
      default: { http: arcRpcUrl ? [arcRpcUrl] : [] },
      public: { http: arcRpcUrl ? [arcRpcUrl] : [] }
    },
    blockExplorers: arcExplorerUrl
      ? {
          default: {
            name: `${arcChainName} Explorer`,
            url: arcExplorerUrl
          }
        }
      : undefined
  };
}

async function waitForArcChain(expectedChainId: string) {
  if (!window.ethereum) return false;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const activeChainId = normalizeProviderChainId(
      await window.ethereum.request({ method: "eth_chainId" })
    );
    if (activeChainId === expectedChainId) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

export async function ensureArcChain() {
  if (!window.ethereum || !arcChainId) return;

  const expectedChainId = chainIdHex(arcChainId);
  const currentChain = normalizeProviderChainId(await window.ethereum.request({
    method: "eth_chainId"
  }));

  if (!currentChain) {
    throw new Error("The wallet did not return a valid network ID.");
  }

  if (currentChain === expectedChainId) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expectedChainId }]
    });
  } catch (error) {
    const code = providerErrorCode(error);

    if (code !== 4902 || !arcRpcUrl) throw error;

    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: expectedChainId,
          chainName: arcChainName,
          nativeCurrency: {
            name: arcCurrencyName,
            symbol: arcCurrencySymbol,
            decimals: 18
          },
          rpcUrls: [arcRpcUrl],
          blockExplorerUrls: arcExplorerUrl ? [arcExplorerUrl] : undefined
        }
      ]
    });

    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expectedChainId }]
    });
  }

  if (!(await waitForArcChain(expectedChainId))) {
    throw new Error("Select ARC Testnet in your wallet to continue.");
  }
}

export async function isArcChainActive() {
  if (!window.ethereum || !arcChainId) return false;
  try {
    return (
      normalizeProviderChainId(await window.ethereum.request({
        method: "eth_chainId"
      })) === chainIdHex(arcChainId)
    );
  } catch {
    return false;
  }
}

export async function getConnectedArcWallet(): Promise<ArcWalletConnection | null> {
  if (!window.ethereum) return null;
  const account = normalizeWalletAddress(await window.ethereum.request({
    method: "eth_accounts"
  }));
  if (!account) return null;
  return { account, chainReady: await isArcChainActive() };
}

export async function connectArcWallet(): Promise<ArcWalletConnection> {
  if (!window.ethereum) {
    throw new Error(
      "No browser wallet detected. Open the app in MetaMask, Rabby, or another EVM wallet browser."
    );
  }

  const account = normalizeWalletAddress(await window.ethereum.request({
    method: "eth_requestAccounts"
  }));

  if (!account) {
    throw new Error("No wallet account was returned.");
  }

  try {
    await ensureArcChain();
    return { account, chainReady: true };
  } catch (error) {
    return {
      account,
      chainReady: false,
      warning: friendlyProviderMessage(
        error,
        "Wallet connected, but ARC Testnet was not selected."
      )
    };
  }
}

function getPublicClient() {
  if (!arcRpcUrl || !arcChainId) {
    throw new Error("ARC RPC configuration is missing.");
  }

  return createPublicClient({
    chain: getArcChain(),
    transport: http(arcRpcUrl)
  });
}

function getContract(mode: ContractMode) {
  const config = contractConfig[mode];
  if (!config.address || !isAddress(config.address)) {
    throw new Error(`${getContractModeLabel(mode)} contract is not configured.`);
  }
  return config;
}

function getMessageData(input: {
  text: string;
  type: MessageType;
  intensity: number;
}) {
  return encodeFunctionData({
    abi: dearArcAbi,
    functionName: "createMessage",
    args: [input.text, messageTypeIndex[input.type], input.intensity]
  });
}

async function getMessageFeeDetails(
  input: {
    from: string;
    text: string;
    type: MessageType;
    intensity: number;
  },
  mode: ContractMode
) {
  const { address } = getContract(mode);
  const client = getPublicClient();
  const data = getMessageData(input);
  const [gasUnits, gasPrice, balanceWei] = await Promise.all([
    client.estimateGas({
      account: input.from as `0x${string}`,
      to: address,
      data
    }),
    client.getGasPrice(),
    client.getBalance({ address: input.from as `0x${string}` })
  ]);
  const feeWei = gasUnits * gasPrice;

  return { address, data, gasUnits, gasPrice, feeWei, balanceWei };
}

export async function estimateArcMessageFee(
  input: {
    from: string;
    text: string;
    type: MessageType;
    intensity: number;
  },
  mode: ContractMode
): Promise<ArcFeeEstimate> {
  const { gasUnits, feeWei, balanceWei } = await getMessageFeeDetails(
    input,
    mode
  );

  return {
    gasUnits,
    feeWei,
    formattedFee: formatUnits(feeWei, 18),
    balanceWei,
    formattedBalance: formatUnits(balanceWei, 18),
    hasSufficientBalance: balanceWei >= feeWei,
    symbol: arcCurrencySymbol
  };
}

export async function submitArcMessage(
  input: {
    from: string;
    text: string;
    type: MessageType;
    intensity: number;
  },
  mode: ContractMode
) {
  if (!window.ethereum) {
    throw new Error("No browser wallet detected.");
  }

  try {
    await ensureArcChain();
  } catch (error) {
    throw new Error(
      friendlyProviderMessage(error, "Select ARC Testnet in your wallet.")
    );
  }

  const { address, data, gasUnits, gasPrice, feeWei, balanceWei } =
    await getMessageFeeDetails(input, mode);

  if (balanceWei < feeWei) {
    throw new Error(
      `This wallet has ${formatUnits(balanceWei, 18)} ${arcCurrencySymbol} on ARC Testnet, but the transaction needs approximately ${formatUnits(feeWei, 18)} ${arcCurrencySymbol}. Get ARC Testnet USDC from the Circle Faucet.`
    );
  }

  let response: unknown;
  try {
    response = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: input.from,
          to: address,
          data,
          value: "0x0",
          gas: toHex(gasUnits),
          gasPrice: toHex(gasPrice)
        }
      ]
    });
  } catch (error) {
    throw new Error(
      friendlyProviderMessage(error, "The wallet could not submit the ARC transaction.")
    );
  }

  const hash = normalizeTransactionHash(response);

  if (!hash) {
    throw new Error("The wallet did not return a valid transaction hash.");
  }

  const receipt = await getPublicClient().waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 60_000
  });

  if (receipt.status !== "success") {
    throw new Error("The ARC transaction reverted.");
  }

  return hash;
}

async function fetchContractMessages(
  mode: ContractMode,
  sender?: string
): Promise<IntentMessage[]> {
  const config = contractConfig[mode];
  if (!config.address || !isAddress(config.address)) return [];

  const client = getPublicClient();
  const latestBlock = await client.getBlockNumber();
  const fallbackStart = latestBlock > 9_999n ? latestBlock - 9_999n : 0n;
  const firstBlock = config.deployBlock
    ? BigInt(config.deployBlock)
    : fallbackStart;
  const logs = [];

  for (
    let fromBlock = firstBlock;
    fromBlock <= latestBlock;
    fromBlock += 10_000n
  ) {
    const toBlock =
      fromBlock + 9_999n > latestBlock ? latestBlock : fromBlock + 9_999n;

    const chunk = await client.getLogs({
      address: config.address,
      event: messageCreatedEvent,
      args: sender && isAddress(sender) ? { sender } : undefined,
      fromBlock,
      toBlock
    });

    logs.push(...chunk);
  }

  return logs.map((log) => {
    const typeIndex = Number(log.args.messageType ?? 0);
    const timestamp = Number(log.args.timestamp ?? 0n);

    return {
      id: `${mode}-${log.transactionHash}-${log.logIndex}`,
      sender: log.args.sender ?? "",
      text: log.args.text ?? "",
      type: messageTypeFromIndex[typeIndex] ?? "thought",
      intensity: Number(log.args.intensity ?? 3),
      timestamp: timestamp > 0 ? timestamp * 1000 : Date.now(),
      txHash: log.transactionHash,
      contractMode: mode
    } satisfies IntentMessage;
  });
}

export async function fetchArcMessages(sender?: string): Promise<IntentMessage[]> {
  if (!hasEventReaderConfig()) return [];

  const results = await Promise.allSettled(
    getConfiguredContractModes().map((mode) =>
      fetchContractMessages(mode, sender)
    )
  );
  const messages = results
    .filter(
      (result): result is PromiseFulfilledResult<IntentMessage[]> =>
        result.status === "fulfilled"
    )
    .flatMap((result) => result.value);

  if (results.every((result) => result.status === "rejected")) {
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    throw rejected?.reason;
  }

  return messages.sort((a, b) => b.timestamp - a.timestamp);
}
