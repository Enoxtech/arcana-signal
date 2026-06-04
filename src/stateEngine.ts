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
  const text = reflectionMap[message.type][vector.intent][vector.execution];
  const toneLine =
    vector.tone === "Charged"
      ? "The emotional field is amplified, so the signal needs structure before scale."
      : vector.tone === "Calm"
        ? "The tone is steady enough to convert the message into a practical rhythm."
        : "The tone is balanced, which makes the next move easier to observe.";

  return {
    vector,
    reflection: `${text} ${toneLine}`,
    nextSignal: nextSignalFor(message.type, vector)
  };
}

const reflectionMap: Record<
  MessageType,
  Record<StateLevel, Record<ExecutionLevel, string>>
> = {
  wish: {
    Unclear: {
      Passive:
        "This wish is still atmospheric; it carries desire but not yet a defined edge.",
      "Moderate pressure":
        "The wish is forming a direction, but the pressure is ahead of the plan.",
      Urgent:
        "The wish is charged and close to becoming a demand; clarity should come first."
    },
    Focused: {
      Passive:
        "The wish has a center, but it is asking for a small action to make it real.",
      "Moderate pressure":
        "The wish is emotionally present and clear enough to become a near-term move.",
      Urgent:
        "The wish is focused and intense; grounding it will keep the signal useful."
    },
    Precise: {
      Passive:
        "The wish is precise, but the execution field is quiet and needs a first step.",
      "Moderate pressure":
        "The wish has shape and timing; consistent action matters more than force.",
      Urgent:
        "The wish is highly defined and highly charged; reduce it to one immediate move."
    }
  },
  goal: {
    Unclear: {
      Passive:
        "The goal is named, but its path is under-specified and will drift without a constraint.",
      "Moderate pressure":
        "The goal has momentum, but the target needs sharper boundaries.",
      Urgent:
        "The goal is moving with pressure before the structure is ready."
    },
    Focused: {
      Passive:
        "The goal is readable, but the execution field is still waiting for commitment.",
      "Moderate pressure":
        "The goal is clear, and progress depends on consistent action rather than intensity.",
      Urgent:
        "The goal is focused and urgent; protect it from expanding into too many tasks."
    },
    Precise: {
      Passive:
        "The goal is precise, but it needs a near-term checkpoint to gain traction.",
      "Moderate pressure":
        "The goal is structurally strong and ready for sequenced execution.",
      Urgent:
        "The goal is exact and under pressure; execution should become narrow and time-boxed."
    }
  },
  question: {
    Unclear: {
      Passive:
        "The question is open-ended and reflective; its value is in narrowing the uncertainty.",
      "Moderate pressure":
        "The question is carrying pressure without a defined decision frame.",
      Urgent:
        "The question is urgent but not yet sharp enough to produce a useful signal."
    },
    Focused: {
      Passive:
        "The question has a clear center and can be tested through observation.",
      "Moderate pressure":
        "The question is focused; the next value comes from separating facts from assumptions.",
      Urgent:
        "The question is focused but urgent, so it needs a boundary before an answer."
    },
    Precise: {
      Passive:
        "The question is precise and calm enough to become a small experiment.",
      "Moderate pressure":
        "The question is exact and active; it is ready to become a decision check.",
      Urgent:
        "The question is precise and charged; slow the tempo before locking in an answer."
    }
  },
  thought: {
    Unclear: {
      Passive:
        "The thought is diffuse, carrying more atmosphere than direction.",
      "Moderate pressure":
        "The thought is forming, but the pressure suggests there is a hidden decision inside it.",
      Urgent:
        "The thought is charged and unstable; it should be observed before it is acted on."
    },
    Focused: {
      Passive:
        "The thought is centered and quiet, useful as a pattern marker.",
      "Moderate pressure":
        "The thought is focused and carries enough weight to become a note for future action.",
      Urgent:
        "The thought is focused but intense; it needs distance before interpretation."
    },
    Precise: {
      Passive:
        "The thought is precise and calm, making it valuable as an anchor in the wallet state.",
      "Moderate pressure":
        "The thought is precise and active; it points toward a behavioral pattern.",
      Urgent:
        "The thought is exact but over-pressurized; reduce interpretation until the tone settles."
    }
  }
};

function nextSignalFor(type: MessageType, vector: StateVector) {
  if (type === "goal") {
    if (vector.execution === "Urgent") {
      return "Break this into one immediate step and one checkpoint before adding scope.";
    }
    if (vector.intent === "Precise") {
      return "Set the next measurable action and commit it to a short time window.";
    }
    return "Define what completion means before pushing for speed.";
  }

  if (type === "wish") {
    if (vector.tone === "Charged") {
      return "Name the smallest behavior that would make this wish visible in the next day.";
    }
    return "Convert the wish into one grounded request or one first action.";
  }

  if (type === "question") {
    if (vector.intent === "Unclear") {
      return "Rewrite the question until it can be answered by one observation or decision.";
    }
    return "Separate the unknowns from the assumptions before seeking an answer.";
  }

  if (vector.tone === "Charged") {
    return "Let the thought cool, then decide whether it is a note, a question, or a goal.";
  }
  return "Keep this as a pattern marker and compare it with the next message.";
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
