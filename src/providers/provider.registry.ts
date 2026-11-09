import type { InterviewMode, ProviderDescriptor } from '@shared';
import type { AiConfig } from '../config/ai.config';
import { AppError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { LlmProvider } from './llm/llm.interface';
import { MockLlmProvider } from './llm/mock-llm.provider';
import { OpenAiLlmProvider } from './llm/openai.provider';
import { DeepgramTranscriptionProvider } from './transcription/deepgram.provider';
import { MockTranscriptionProvider } from './transcription/mock-transcription.provider';
import type { TranscriptionProvider } from './transcription/transcription.interface';

export interface ProviderSet {
  transcription: TranscriptionProvider;
  llm: LlmProvider;
}

export interface ModeAvailability {
  available: boolean;
  reason: string | null;
}

export interface ProviderDescriptors {
  transcription: ProviderDescriptor;
  llm: ProviderDescriptor;
}

/** What services need to know about providers — never the concrete vendor classes. */
export interface ProviderCatalog {
  resolve(mode: InterviewMode): ProviderSet;
  availability(mode: InterviewMode): ModeAvailability;
  describe(mode: InterviewMode): ProviderDescriptors;
}

export interface ProviderRegistryInit {
  demo: ProviderSet;
  live: ProviderSet | null;
  /** Shown to users when Live Mode cannot be used. */
  liveUnavailableReason?: string;
  /** Descriptors advertised for Live Mode even when it is unavailable. */
  liveDescriptors?: ProviderDescriptors;
}

export class ProviderRegistry implements ProviderCatalog {
  constructor(private readonly init: ProviderRegistryInit) {}

  resolve(mode: InterviewMode): ProviderSet {
    if (mode === 'demo') return this.init.demo;
    if (!this.init.live) {
      throw new AppError(
        'LIVE_MODE_UNAVAILABLE',
        this.availability('live').reason ?? 'Live Mode is unavailable',
        {
          statusCode: 409,
        },
      );
    }
    return this.init.live;
  }

  availability(mode: InterviewMode): ModeAvailability {
    if (mode === 'demo' || this.init.live) return { available: true, reason: null };
    return {
      available: false,
      reason: this.init.liveUnavailableReason ?? 'Live Mode is not configured on the server',
    };
  }

  describe(mode: InterviewMode): ProviderDescriptors {
    const set = mode === 'demo' ? this.init.demo : this.init.live;
    if (set) return { transcription: set.transcription.descriptor, llm: set.llm.descriptor };
    return (
      this.init.liveDescriptors ?? {
        transcription: { name: 'deepgram', model: null, simulated: false },
        llm: { name: 'openai', model: null, simulated: false },
      }
    );
  }
}

/**
 * Composition helper used at startup. Demo Mode always uses the simulated
 * providers. Live Mode requires Deepgram; without an OpenAI key, Live Mode answers
 * come from the simulated LLM and are labelled as such.
 */
export function createProviderRegistry(config: AiConfig, logger: Logger): ProviderRegistry {
  const demo: ProviderSet = {
    transcription: new MockTranscriptionProvider({ speed: config.mock.scriptSpeed }),
    llm: new MockLlmProvider({
      firstTokenDelayMs: config.mock.firstTokenDelayMs,
      tokenDelayMs: config.mock.tokenDelayMs,
    }),
  };

  const { openai, deepgram } = config;
  const liveLlm: LlmProvider = openai.apiKey
    ? new OpenAiLlmProvider({ ...openai, apiKey: openai.apiKey })
    : demo.llm;

  const live: ProviderSet | null = deepgram.apiKey
    ? {
        transcription: new DeepgramTranscriptionProvider(
          { ...deepgram, apiKey: deepgram.apiKey },
          logger.child({ provider: 'deepgram' }),
        ),
        llm: liveLlm,
      }
    : null;

  return new ProviderRegistry({
    demo,
    live,
    liveUnavailableReason: 'Set DEEPGRAM_API_KEY on the server to enable Live Mode',
    liveDescriptors: {
      transcription: { name: 'deepgram', model: deepgram.model, simulated: false },
      llm: liveLlm.descriptor,
    },
  });
}
