import type { FastifyRequest } from 'fastify';
import { type z } from 'zod';
import type { HandlerResult } from '../utils/async-handler';
import { ValidationError } from '../utils/errors';

type Output<TSchema> = TSchema extends z.ZodType ? z.output<TSchema> : undefined;

export interface RequestSchemas<TParams, TBody, TQuery> {
  params?: TParams;
  body?: TBody;
  query?: TQuery;
}

export interface ValidatedInput<TParams, TBody, TQuery> {
  params: Output<TParams>;
  body: Output<TBody>;
  query: Output<TQuery>;
}

/** Parses `data` with `schema`, throwing a ValidationError with readable issue details. */
export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  data: unknown,
  location: string,
): z.output<TSchema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(`Invalid request ${location}`, {
      issues: result.error.issues.map((issue) => ({
        path: [location, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/**
 * Validates params/body/query with Zod before the controller runs, then hands the
 * controller fully typed input. Controllers never see unvalidated request data.
 */
export function validated<
  TResult,
  TParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TQuery extends z.ZodType | undefined = undefined,
>(
  schemas: RequestSchemas<TParams, TBody, TQuery>,
  handler: (
    input: ValidatedInput<TParams, TBody, TQuery>,
  ) => Promise<HandlerResult<TResult>> | HandlerResult<TResult>,
) {
  return (request: FastifyRequest): Promise<HandlerResult<TResult>> | HandlerResult<TResult> => {
    const input = {
      params: schemas.params ? parseOrThrow(schemas.params, request.params, 'params') : undefined,
      body: schemas.body ? parseOrThrow(schemas.body, request.body ?? {}, 'body') : undefined,
      query: schemas.query ? parseOrThrow(schemas.query, request.query, 'query') : undefined,
    } as ValidatedInput<TParams, TBody, TQuery>;
    return handler(input);
  };
}
