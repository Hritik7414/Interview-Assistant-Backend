import { z } from 'zod';
import { CONTEXT_LIMITS } from '../constants/domain.constants';

const limitedText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max.toLocaleString('en-US')} characters`);

const resumeField = limitedText(CONTEXT_LIMITS.resume, 'Resume');
const jobDescriptionField = limitedText(CONTEXT_LIMITS.jobDescription, 'Job description');
const instructionsField = limitedText(CONTEXT_LIMITS.instructions, 'Instructions');

/** Candidate context used to ground generated answers. All fields are optional free text. */
export const InterviewContextSchema = z.object({
  resume: resumeField.default(''),
  jobDescription: jobDescriptionField.default(''),
  instructions: instructionsField.default(''),
});

/** Partial context update; at least one field must be present. */
export const InterviewContextPatchSchema = z
  .object({
    resume: resumeField.optional(),
    jobDescription: jobDescriptionField.optional(),
    instructions: instructionsField.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'At least one context field must be provided',
  });
