import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  isAddress,
  parseAbiItem,
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
  symbol: string;
}

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
  return value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
}

function chainIdHex(value: string) {
  return value.startsWith("0x")
    ? value
    : `0x${parseChainId(value).toString(16)}`;
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

export async function ensureArcChain() {
  if (!window.ethereum || !arcChainId) return;

  const expectedChainId = chainIdHex(arcChainId);
  const currentChain = (await window.ethereum.request({
    method: "eth_chainId"
  })) as string;

  if (currentChain.toLowerCase() === expectedChainId.toLowerCase()) return;

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expectedChainId }]
    });
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? Number((error as { code: unknown }).code)
        : 0;

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
  }
}

export async function connectArcWallet() {
  if (!window.ethereum) {
    throw new Error(
      "No browser wallet detected. Open the app in MetaMask, Rabby, or another EVM wallet browser."
    );
  }

  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts"
  })) as string[];

  if (!accounts?.[0] || !isAddress(accounts[0])) {
    throw new Error("No wallet account was returned.");
  }

  await ensureArcChain();
  return accounts[0];
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

export async function estimateArcMessageFee(
  input: {
    from: string;
    text: string;
    type: MessageType;
    intensity: number;
  },
  mode: ContractMode
): Promise<ArcFeeEstimate> {
  const { address } = getContract(mode);
  const client = getPublicClient();
  const data = getMessageData(input);
  const [gasUnits, gasPrice] = await Promise.all([
    client.estimateGas({
      account: input.from as `0x${string}`,
      to: address,
      data
    }),
    client.getGasPrice()
  ]);
  const feeWei = gasUnits * gasPrice;

  return {
    gasUnits,
    feeWei,
    formattedFee: formatUnits(feeWei, 18),
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

  const { address } = getContract(mode);
  await ensureArcChain();

  const hash = (await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: input.from,
        to: address,
        data: getMessageData(input)
      }
    ]
  })) as `0x${string}`;

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
