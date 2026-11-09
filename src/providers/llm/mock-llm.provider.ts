import type { ProviderDescriptor } from '@shared';
import { abortableDelay } from '../../utils/runtime';
import type {
  LlmCompletionRequest,
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
} from './llm.interface';

export interface MockLlmOptions {
  firstTokenDelayMs?: number;
  tokenDelayMs?: number;
}

interface CannedAnswer {
  matches: RegExp;
  text: string;
}

/**
 * Coaching-style canned answers. Bracketed placeholders make it explicit that
 * Demo Mode never invents the candidate's experience.
 */
const CANNED_ANSWERS: readonly CannedAnswer[] = [
  {
    matches: /\b(background|yourself|walk me through|drew you)\b/i,
    text: [
      "- I'm a [current title] with [X] years building [core domain from your resume].",
      '- Most recently at [company], I owned [project] end to end, from design to rollout.',
      "- I'm strongest at turning ambiguous requirements into shipped, well-tested systems.",
      '- This role stands out because it combines [key responsibility from the job description] with [team or product focus].',
      "- I'd bring hands-on delivery plus clear communication with stakeholders.",
    ].join('\n'),
  },
  {
    matches: /\b(design|architect|scale|system)\b/i,
    text: [
      '- Start by clarifying scale: fan-out volume, latency target and delivery guarantees.',
      '- Producers publish events to a partitioned log such as Kafka for durability and replay.',
      '- Stateless workers resolve recipients and preferences, then enqueue per channel.',
      '- WebSocket gateways push to online users; APNs, FCM or email cover offline users.',
      '- Idempotency keys, retries with backoff and a dead-letter queue give at-least-once delivery.',
      '- Track queue lag and end-to-end latency, and scale gateways horizontally.',
    ].join('\n'),
  },
  {
    matches: /\b(disagree|disagreed|conflict|teammate|time you)\b/i,
    text: [
      '- Situation: on [project], a teammate and I disagreed about [technical choice].',
      '- I started by making sure I understood their constraints and reasoning.',
      '- We agreed on decision criteria — risk, performance, delivery time — instead of opinions.',
      '- I proposed a short spike so we could compare both options with real data.',
      '- The data favoured [option]; we recorded the decision in an ADR.',
      '- Result: we shipped on schedule and kept a strong working relationship.',
    ].join('\n'),
  },
  {
    matches: /\b(test|testing|quality)\b/i,
    text: [
      '- I use layers: fast unit tests on business logic and contract tests between services.',
      '- Integration tests run against real dependencies in containers, not mocks.',
      '- I inject faults deliberately — timeouts, partitions, duplicate and out-of-order messages.',
      '- Idempotency and retry behaviour are verified explicitly rather than assumed.',
      '- In production, canary releases, tracing and SLO-based alerts catch what tests miss.',
    ].join('\n'),
  },
];

const FALLBACK_ANSWER = [
  '- Briefly restate the question to confirm what is being asked.',
  '- Lead with a direct, one-sentence answer.',
  '- Back it with a specific example from your resume: [project], [your role], [measurable result].',
  '- Mention the trade-offs you weighed and why you chose your approach.',
  '- Close by connecting it to what this role needs.',
].join('\n');

/**
 * Simulated LLM for Demo Mode and tests. Streams canned answers token by token,
 * honours AbortSignal immediately, and is labelled `simulated: true` end to end.
 */
export class MockLlmProvider implements LlmProvider {
  readonly descriptor: ProviderDescriptor = {
    name: 'mock-llm',
    model: 'scripted-demo',
    simulated: true,
  };

  private readonly firstTokenDelayMs: number;
  private readonly tokenDelayMs: number;

  constructor(options: MockLlmOptions = {}) {
    this.firstTokenDelayMs = options.firstTokenDelayMs ?? 350;
    this.tokenDelayMs = options.tokenDelayMs ?? 35;
  }

  async *stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamEvent> {
    const answer = selectCannedAnswer(extractQuestion(request.messages));
    const tokens = answer.match(/\S+\s*/g) ?? [];

    await abortableDelay(this.firstTokenDelayMs, request.signal);
    for (const [index, token] of tokens.entries()) {
      yield { type: 'delta', text: token };
      if (index < tokens.length - 1) await abortableDelay(this.tokenDelayMs, request.signal);
    }
    yield { type: 'done', finishReason: 'stop' };
  }
}

export function selectCannedAnswer(question: string): string {
  return CANNED_ANSWERS.find((answer) => answer.matches.test(question))?.text ?? FALLBACK_ANSWER;
}

function extractQuestion(messages: readonly LlmMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const match = lastUser?.content.match(/<question>\s*([\s\S]*?)\s*<\/question>/);
  return match?.[1] ?? lastUser?.content ?? '';
}
