import {
  createPublicClient,
  encodeFunctionData,
  http,
  isAddress,
  parseAbiItem,
  type Chain
} from "viem";
import type { IntentMessage, MessageType } from "./types";

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

const contractAddress = import.meta.env.VITE_DEARARC_CONTRACT_ADDRESS as
  | `0x${string}`
  | undefined;

const arcChainId = import.meta.env.VITE_ARC_CHAIN_ID as string | undefined;
const arcRpcUrl = import.meta.env.VITE_ARC_RPC_URL as string | undefined;
const arcChainName = import.meta.env.VITE_ARC_CHAIN_NAME || "ARC Testnet";
const arcCurrencyName = import.meta.env.VITE_ARC_NATIVE_CURRENCY_NAME || "USDC";
const arcCurrencySymbol =
  import.meta.env.VITE_ARC_NATIVE_CURRENCY_SYMBOL || "USDC";
const arcExplorerUrl = import.meta.env.VITE_ARC_BLOCK_EXPLORER_URL as
  | string
  | undefined;
const deployBlock = import.meta.env.VITE_DEARARC_DEPLOY_BLOCK as
  | string
  | undefined;

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

export function hasContractConfig() {
  return Boolean(contractAddress && isAddress(contractAddress));
}

export function hasEventReaderConfig() {
  return Boolean(hasContractConfig() && arcRpcUrl && arcChainId);
}

export function getChainModeLabel() {
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

export async function submitArcMessage(input: {
  from: string;
  text: string;
  type: MessageType;
  intensity: number;
}) {
  if (!window.ethereum || !contractAddress || !isAddress(contractAddress)) {
    throw new Error("ARC contract is not configured.");
  }

  await ensureArcChain();

  const data = encodeFunctionData({
    abi: dearArcAbi,
    functionName: "createMessage",
    args: [input.text, messageTypeIndex[input.type], input.intensity]
  });

  const hash = (await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: input.from,
        to: contractAddress,
        data
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

export async function fetchArcMessages(sender?: string): Promise<IntentMessage[]> {
  if (!contractAddress || !isAddress(contractAddress) || !arcRpcUrl || !arcChainId) {
    return [];
  }

  const client = getPublicClient();

  const latestBlock = await client.getBlockNumber();
  const fallbackStart = latestBlock > 9_999n ? latestBlock - 9_999n : 0n;
  const firstBlock = deployBlock ? BigInt(deployBlock) : fallbackStart;
  const logs = [];

  for (let fromBlock = firstBlock; fromBlock <= latestBlock; fromBlock += 10_000n) {
    const toBlock =
      fromBlock + 9_999n > latestBlock ? latestBlock : fromBlock + 9_999n;

    const chunk = await client.getLogs({
      address: contractAddress,
      event: messageCreatedEvent,
      args: sender && isAddress(sender) ? { sender } : undefined,
      fromBlock,
      toBlock
    });

    logs.push(...chunk);
  }

  return logs
    .map((log) => {
      const typeIndex = Number(log.args.messageType ?? 0);
      const timestamp = Number(log.args.timestamp ?? 0n);

      return {
        id: `${log.transactionHash}-${log.logIndex}`,
        sender: log.args.sender ?? "",
        text: log.args.text ?? "",
        type: messageTypeFromIndex[typeIndex] ?? "thought",
        intensity: Number(log.args.intensity ?? 3),
        timestamp: timestamp > 0 ? timestamp * 1000 : Date.now(),
        txHash: log.transactionHash
      } satisfies IntentMessage;
    })
    .sort((a, b) => b.timestamp - a.timestamp);
}
