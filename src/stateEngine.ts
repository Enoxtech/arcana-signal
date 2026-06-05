import type {
  ExecutionLevel,
  IntentMessage,
  MessageType,
  StateLevel,
  StateReport,
  StateVector,
  ToneLevel,
  WalletProfile
} from "./types";

const TYPE_LABELS: Record<MessageType, string> = {
  wish: "Wish",
  goal: "Goal",
  question: "Question",
  thought: "Thought"
};

const clamp = (value: number, min = 0, max = 2) =>
  Math.min(max, Math.max(min, value));

const pickIntent = (score: number): StateLevel =>
  (["Unclear", "Focused", "Precise"] as const)[clamp(Math.round(score))];

const pickExecution = (score: number): ExecutionLevel =>
  (["Passive", "Moderate pressure", "Urgent"] as const)[
    clamp(Math.round(score))
  ];

const pickTone = (score: number): ToneLevel =>
  (["Calm", "Neutral", "Charged"] as const)[clamp(Math.round(score))];

const hexToSeed = (txHash: string) => {
  const clean = txHash.replace(/^0x/, "").slice(0, 32) || "0";
  return BigInt(`0x${clean}`);
};

const dimensionFromSeed = (seed: bigint, offset: bigint) =>
  Number((seed >> offset) % 3n);

const typeBias: Record<
  MessageType,
  { clarity: number; execution: number; tone: number }
> = {
  wish: { clarity: 0, execution: -0.35, tone: 0.55 },
  goal: { clarity: 0.45, execution: 0.7, tone: 0.05 },
  question: { clarity: -0.35, execution: -0.2, tone: 0.25 },
  thought: { clarity: 0.1, execution: -0.25, tone: -0.3 }
};

export const compactAddress = (value: string, left = 4, right = 4) => {
  if (!value) return "";
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
};

export const formatType = (type: MessageType) => TYPE_LABELS[type];

export async function createTxHash(input: {
  sender: string;
  text: string;
  type: MessageType;
  intensity: number;
  timestamp: number;
  nonce: number;
}) {
  const source = [
    input.sender.toLowerCase(),
    input.text.trim(),
    input.type,
    input.intensity,
    input.timestamp,
    input.nonce
  ].join("|");
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

export function deriveStateVector(message: IntentMessage): StateVector {
  const seed = hexToSeed(message.txHash);
  const baseClarity = dimensionFromSeed(seed, 0n);
  const baseExecution = dimensionFromSeed(seed, 4n);
  const baseTone = dimensionFromSeed(seed, 8n);
  const normalizedIntensity = (message.intensity - 3) / 2;
  const bias = typeBias[message.type];

  const clarityScore = clamp(
    baseClarity + bias.clarity + (message.type === "question" ? -0.2 : 0.12)
  );
  const executionScore = clamp(
    baseExecution + bias.execution + normalizedIntensity * 0.58
  );
  const toneScore = clamp(baseTone + bias.tone + normalizedIntensity * 0.72);

  return {
    seed,
    clarityScore,
    executionScore,
    toneScore,
    intent: pickIntent(clarityScore),
    execution: pickExecution(executionScore),
    tone: pickTone(toneScore)
  };
}

export function interpretMessage(message: IntentMessage): StateReport {
  const vector = deriveStateVector(message);
  const subject = subjectFor(message);

  return {
    vector,
    reflection: reflectionFor(message, vector, subject),
    nextSignal: nextSignalFor(message, vector, subject)
  };
}

const fallbackSubject: Record<MessageType, string> = {
  wish: "this wish",
  goal: "this goal",
  question: "this question",
  thought: "this thought"
};

const leadingPatterns: Record<MessageType, RegExp[]> = {
  wish: [
    /^(?:i\s+)?wish(?:ed)?(?:\s+for|\s+to)?\s+/i,
    /^(?:i\s+)?hope(?:\s+for|\s+to)?\s+/i,
    /^(?:i\s+)?want(?:\s+to|\s+for)?\s+/i,
    /^(?:i\s+)?would\s+like(?:\s+to|\s+for)?\s+/i,
    /^(?:i\s+)?need(?:\s+to|\s+for)?\s+/i,
    /^(?:my\s+wish\s+is|my\s+dream\s+is)(?:\s+to|\s+for)?\s+/i
  ],
  goal: [
    /^(?:my\s+goal\s+is|my\s+plan\s+is)(?:\s+to)?\s+/i,
    /^(?:i\s+)?want\s+to\s+/i,
    /^(?:i\s+)?will\s+/i,
    /^(?:i\s+)?plan\s+to\s+/i,
    /^(?:i\s+)?am\s+going\s+to\s+/i,
    /^(?:i'm|i am)\s+going\s+to\s+/i,
    /^(?:i\s+)?need\s+to\s+/i,
    /^to\s+/i
  ],
  question: [],
  thought: [
    /^(?:i\s+)?keep\s+thinking\s+about\s+/i,
    /^(?:i\s+)?am\s+thinking\s+about\s+/i,
    /^(?:i'm)\s+thinking\s+about\s+/i,
    /^(?:i\s+)?think\s+about\s+/i,
    /^thinking\s+about\s+/i,
    /^(?:i\s+)?feel\s+like\s+/i,
    /^(?:i\s+)?noticed\s+that\s+/i
  ]
};

const wishClarity: Record<StateLevel, string> = {
  Unclear:
    "It still needs a little more detail, so make it easier to name and picture.",
  Focused:
    "The direction is clear enough to turn into one small real-world step.",
  Precise: "It is specific enough to become a plan instead of only a hope."
};

const goalClarity: Record<StateLevel, string> = {
  Unclear: "The goal needs a clearer finish line before you push hard.",
  Focused: "The direction is clear; now it needs consistency.",
  Precise: "The goal is specific enough to track and measure."
};

const questionClarity: Record<StateLevel, string> = {
  Unclear: "The useful move is to narrow it until one part can be answered.",
  Focused: "You already have a clear center; separate facts from guesses.",
  Precise: "It is specific enough to test with one decision or observation."
};

const thoughtClarity: Record<StateLevel, string> = {
  Unclear:
    "It may not need action yet; it may just be showing what is on your mind.",
  Focused: "There is a clear theme here, so keep it as a pattern marker.",
  Precise:
    "It is specific enough to return to later and compare with your next messages."
};

const executionAdvice: Record<ExecutionLevel, string> = {
  Passive: "Start small so it does not stay only as an idea.",
  "Moderate pressure": "There is enough momentum here to take a practical step.",
  Urgent: "Because it feels urgent, keep the next step narrow."
};

const wishToneAdvice: Record<ToneLevel, string> = {
  Calm: "You can move with it steadily without forcing the outcome.",
  Neutral: "A simple plan will make it easier to understand what comes next.",
  Charged:
    "Because the feeling is strong, turn it into a small plan instead of only holding the emotion."
};

const questionToneAdvice: Record<ToneLevel, string> = {
  Calm: "You can think through it without pressure.",
  Neutral: "Keep it practical and look for the first thing you can confirm.",
  Charged: "If it feels heavy, slow it down before deciding."
};

const thoughtToneAdvice: Record<ToneLevel, string> = {
  Calm: "You can observe it without rushing to act.",
  Neutral: "Watch whether it becomes a wish, goal, or question.",
  Charged: "Let it settle before turning it into a decision."
};

function subjectFor(message: IntentMessage) {
  const cleaned = compactText(message.text).replace(/[.!?]+$/g, "").trim();
  const withoutLead = leadingPatterns[message.type].reduce((value, pattern) => {
    const next = value.replace(pattern, "");
    return next === value ? value : next.trim();
  }, cleaned);

  return withoutLead.length >= 2 ? withoutLead : fallbackSubject[message.type];
}

function compactText(value: string, maxLength = 120) {
  const cleaned = value.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const clipped = cleaned.slice(0, maxLength).replace(/\s+\S*$/g, "").trim();
  return `${clipped || cleaned.slice(0, maxLength)}...`;
}

function withSentenceEnding(value: string) {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function reflectionFor(
  message: IntentMessage,
  vector: StateVector,
  subject: string
) {
  if (message.type === "wish") {
    const opening =
      message.intensity >= 4
        ? `That is good to hear. You are naming a strong wish: ${subject}. It makes sense that it feels important.`
        : `That is good to hear. You are naming a real wish: ${subject}.`;

    return `${opening} ${wishClarity[vector.intent]} ${wishToneAdvice[vector.tone]}`;
  }

  if (message.type === "goal") {
    return `Good move putting this goal onchain: ${subject}. ${goalClarity[vector.intent]} ${executionAdvice[vector.execution]}`;
  }

  if (message.type === "question") {
    const question = compactText(message.text, 120);
    return `That is a fair question: ${withSentenceEnding(question)} ${questionClarity[vector.intent]} ${questionToneAdvice[vector.tone]}`;
  }

  return `That thought is worth noting: ${subject}. ${thoughtClarity[vector.intent]} ${thoughtToneAdvice[vector.tone]}`;
}

function nextSignalFor(
  message: IntentMessage,
  vector: StateVector,
  subject: string
) {
  if (message.type === "goal") {
    if (vector.execution === "Urgent") {
      return "Pick one next action, give it a deadline, and finish it before adding more tasks.";
    }
    if (vector.intent === "Precise") {
      return "Set one clear checkpoint for this goal so you can see progress this week.";
    }
    return "Write what success looks like, then choose the first task that moves this goal forward.";
  }

  if (message.type === "wish") {
    if (vector.intent === "Unclear") {
      return "Add one clear detail to this wish: what would make it feel real to you?";
    }
    if (vector.tone === "Charged" || vector.execution === "Urgent") {
      return "Choose one small action you can take in the next 24 hours that supports this wish.";
    }
    return "Write one simple step that can move this wish closer to real life this week.";
  }

  if (message.type === "question") {
    if (vector.intent === "Unclear") {
      return "Rewrite the question in one simple sentence, then list what you already know.";
    }
    return "Write what you know, what you are unsure about, and the first thing to confirm.";
  }

  if (vector.tone === "Charged") {
    return "Let the thought settle, then decide if it should become a wish, goal, or question.";
  }
  return "Keep this note, then check later whether it keeps showing up in your messages.";
}

export function buildWalletProfile(messages: IntentMessage[]): WalletProfile {
  if (!messages.length) {
    return {
      total: 0,
      averageIntensity: 0,
      dominantType: "none",
      typePercentages: { wish: 0, goal: 0, question: 0, thought: 0 },
      executionBiasScore: 0,
      executionBias: "Low",
      pattern: "No wallet pattern encoded yet."
    };
  }

  const counts = messages.reduce(
    (acc, message) => {
      acc[message.type] += 1;
      return acc;
    },
    { wish: 0, goal: 0, question: 0, thought: 0 } satisfies Record<
      MessageType,
      number
    >
  );

  const averageIntensity =
    messages.reduce((sum, message) => sum + message.intensity, 0) /
    messages.length;
  const typePercentages = Object.fromEntries(
    Object.entries(counts).map(([type, count]) => [
      type,
      Math.round((count / messages.length) * 100)
    ])
  ) as Record<MessageType, number>;

  const dominantType = (Object.entries(counts).sort(
    (a, b) => b[1] - a[1]
  )[0][0] || "none") as MessageType;

  const stateAverage =
    messages.reduce((sum, message) => {
      const state = deriveStateVector(message);
      return sum + state.executionScore + state.clarityScore * 0.45;
    }, 0) / messages.length;

  const executionBiasScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        counts.goal * 22 +
          counts.question * 8 +
          counts.thought * 5 -
          counts.wish * 4 +
          averageIntensity * 9 +
          stateAverage * 12
      )
    )
  );

  const executionBias =
    executionBiasScore >= 72
      ? "Strong"
      : executionBiasScore >= 48
        ? "Moderate"
        : executionBiasScore >= 26
          ? "Low-Moderate"
          : "Low";

  return {
    total: messages.length,
    averageIntensity,
    dominantType,
    typePercentages,
    executionBiasScore,
    executionBias,
    pattern: patternFor(dominantType, executionBias, typePercentages)
  };
}

function patternFor(
  type: MessageType,
  bias: WalletProfile["executionBias"],
  percentages: Record<MessageType, number>
) {
  if (type === "wish") {
    return `${percentages.wish}% wish-driven with ${bias.toLowerCase()} execution bias. Desire is leading the wallet state.`;
  }
  if (type === "goal") {
    return `${percentages.goal}% goal-driven with ${bias.toLowerCase()} execution bias. Action structure is leading the wallet state.`;
  }
  if (type === "question") {
    return `${percentages.question}% question-driven with ${bias.toLowerCase()} execution bias. Inquiry is shaping the wallet state.`;
  }
  return `${percentages.thought}% thought-driven with ${bias.toLowerCase()} execution bias. Reflection is shaping the wallet state.`;
}
