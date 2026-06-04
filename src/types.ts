export type MessageType = "wish" | "goal" | "question" | "thought";

export type StateLevel = "Unclear" | "Focused" | "Precise";
export type ExecutionLevel = "Passive" | "Moderate pressure" | "Urgent";
export type ToneLevel = "Calm" | "Neutral" | "Charged";

export interface IntentMessage {
  id: string;
  sender: string;
  text: string;
  type: MessageType;
  intensity: number;
  timestamp: number;
  txHash: string;
}

export interface StateVector {
  intent: StateLevel;
  execution: ExecutionLevel;
  tone: ToneLevel;
  seed: bigint;
  clarityScore: number;
  executionScore: number;
  toneScore: number;
}

export interface StateReport {
  vector: StateVector;
  reflection: string;
  nextSignal: string;
}

export interface WalletProfile {
  total: number;
  averageIntensity: number;
  dominantType: MessageType | "none";
  typePercentages: Record<MessageType, number>;
  executionBiasScore: number;
  executionBias: "Low" | "Low-Moderate" | "Moderate" | "Strong";
  pattern: string;
}
