import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadEnv(resolve(root, ".env"));
loadEnv(resolve(root, ".env.local"));

const rpcUrl = process.env.VITE_ARC_RPC_URL;
const chainIdRaw = process.env.VITE_ARC_CHAIN_ID;
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

if (!rpcUrl) throw new Error("Missing VITE_ARC_RPC_URL.");
if (!chainIdRaw) throw new Error("Missing VITE_ARC_CHAIN_ID.");
if (!privateKey) throw new Error("Missing DEPLOYER_PRIVATE_KEY.");

const chainId = chainIdRaw.startsWith("0x")
  ? Number.parseInt(chainIdRaw, 16)
  : Number(chainIdRaw);

const sourcePath = resolve(root, "contracts", "DearArcMessages.sol");
const source = readFileSync(sourcePath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    "DearArcMessages.sol": { content: source }
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = output.errors?.filter((item) => item.severity === "error") ?? [];

if (errors.length) {
  throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
}

const contract = output.contracts["DearArcMessages.sol"].DearArcMessages;
const bytecode = `0x${contract.evm.bytecode.object}`;
const account = privateKeyToAccount(
  privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
);

const arc = defineChain({
  id: chainId,
  name: process.env.VITE_ARC_CHAIN_NAME || "ARC Testnet",
  nativeCurrency: {
    decimals: 18,
    name: process.env.VITE_ARC_NATIVE_CURRENCY_NAME || "USDC",
    symbol: process.env.VITE_ARC_NATIVE_CURRENCY_SYMBOL || "USDC"
  },
  rpcUrls: {
    default: { http: [rpcUrl] }
  },
  blockExplorers: process.env.VITE_ARC_BLOCK_EXPLORER_URL
    ? {
        default: {
          name: "ARC Explorer",
          url: process.env.VITE_ARC_BLOCK_EXPLORER_URL
        }
      }
    : undefined
});

const publicClient = createPublicClient({ chain: arc, transport: http(rpcUrl) });
const walletClient = createWalletClient({
  account,
  chain: arc,
  transport: http(rpcUrl)
});

const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) {
  throw new Error(`Deployer ${account.address} has zero native balance.`);
}

console.log(`Deploying DearArcMessages from ${account.address}`);
console.log(`Native balance: ${balance} wei`);

const hash = await walletClient.deployContract({
  abi: contract.abi,
  bytecode,
  account,
  value: parseEther("0")
});

console.log(`Deploy tx: ${hash}`);

const receipt = await publicClient.waitForTransactionReceipt({ hash });

console.log(`Contract: ${receipt.contractAddress}`);
console.log(`Deploy block: ${receipt.blockNumber}`);
console.log("");
console.log("Add these to .env:");
console.log(`VITE_DEARARC_CONTRACT_ADDRESS=${receipt.contractAddress}`);
console.log(`VITE_DEARARC_DEPLOY_BLOCK=${receipt.blockNumber}`);

function loadEnv(path) {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
