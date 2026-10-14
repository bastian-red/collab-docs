/**
 * A validation pipe that takes a schema, per argument.
 *
 * **Per argument, not global**, and that is the design rather than a shortcut.
 * Nest's usual pattern is a class-validator DTO class per endpoint, and this
 * codebase already has its shapes: they live in `packages/shared` as zod schemas
 * that the web app, the E2E suite and this API all import. A DTO class would be a
 * second definition of every request body, and two definitions of one shape agree
 * right up until one of them changes.
 *
 * A global zod pipe cannot work either, because it has no way to know which
 * schema belongs to which parameter. So the schema is named at the call site:
 *
 *     @Post()
 *     create(@Body(new ZodPipe(createDocumentSchema)) input: CreateDocumentInput) {}
 *
 * ---------------------------------------------------------------------------
 * The issue list never reaches the client
 *
 * Zod's message names internal field paths and, for a value that failed a length
 * rule, quotes the input back. In this product that input is a document title, a
 * version label or somebody's password. The response is a fixed sentence plus the
 * field NAMES, which is enough for a form to highlight what to fix and carries
 * none of the values.
 */
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/** The response body a failed parse produces. Exported so the filter and the tests share it. */
export interface InvalidBody {
  readonly code: 'INVALID';
  readonly message: string;
  readonly fields: string[];
}

export function invalidBody(fields: readonly string[]): InvalidBody {
  return {
    code: 'INVALID',
    message: 'That request was not in a shape this server accepts.',
    fields: [...fields],
  };
}

/** The field names a zod error names, de-duplicated, in first-seen order. */
export function fieldsOf(issues: readonly { path: (string | number)[] }[]): string[] {
  return [
    ...new Set(issues.map((issue) => issue.path.join('.')).filter((path) => path.length > 0)),
  ];
}

/**
 * `ZodType<Out, ZodTypeDef, unknown>` rather than `ZodType<Out>`.
 *
 * Zod's third parameter is the schema's INPUT type, and it defaults to the
 * output. Any schema carrying a `.transform` -- every query-string schema here,
 * where a page size arrives as `'25'` and leaves as `25` -- has an input that
 * differs from its output, and `ZodType<Out>` refuses it. Widening the input to
 * `unknown` is honest: this pipe is handed a parsed JSON body or a query object
 * and has no idea what shape it is, which is why it is running at all.
 */
@Injectable()
export class ZodPipe<Out> implements PipeTransform<unknown, Out> {
  constructor(private readonly schema: ZodType<Out, ZodTypeDef, unknown>) {}

  transform(value: unknown): Out {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BadRequestException(invalidBody(fieldsOf(parsed.error.issues)));
  }
}
