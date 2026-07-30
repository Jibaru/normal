import { JSONSchema, Schema } from "effect";

const utcTimestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z(?![\s\S])/;

const isRealUtcTimestamp = (value: string): boolean => {
  const parsed = new Date(value);

  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 19) === value.slice(0, 19)
  );
};

export const UtcTimestamp = Schema.String.pipe(
  Schema.pattern(utcTimestampPattern),
  Schema.filter(isRealUtcTimestamp, {
    jsonSchema: {
      format: "date-time",
    },
  }),
  Schema.brand("UtcTimestamp"),
);
export type UtcTimestamp = typeof UtcTimestamp.Type;

export const makePublicObjectContract = <
  const Fields extends Schema.Struct.Fields,
>(
  fields: Fields &
    ([Schema.Struct.Context<Fields>] extends [never] ? unknown : never),
) => {
  const schema = Schema.Struct(fields);
  const noContextSchema = schema as unknown as Schema.Schema<
    typeof schema.Type,
    typeof schema.Encoded,
    never
  >;

  return {
    schema,
    jsonSchema: JSONSchema.make(schema, {
      target: "jsonSchema2020-12",
    }),
    decodeUnknown: Schema.decodeUnknownSync(noContextSchema, {
      onExcessProperty: "error",
    }),
  } as const;
};

export type PublicObjectContract<A> = {
  readonly decodeUnknown: (input: unknown) => A;
};
