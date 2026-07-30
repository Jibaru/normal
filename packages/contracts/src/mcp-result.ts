import type { PublicObjectContract } from "./mcp-schema";

export type TextContentBlock = {
  readonly type: "text";
  readonly text: string;
};

export type AdditionalContentBlock = {
  readonly type: "resource_link";
  readonly [key: string]: unknown;
};

export type SuccessResult<A> = {
  readonly structuredContent: A;
  readonly content: readonly [
    TextContentBlock,
    ...ReadonlyArray<AdditionalContentBlock>,
  ];
};

export const makeSuccessResultBuilder =
  <A>(contract: PublicObjectContract<A>) =>
  (
    input: unknown,
    additionalContent: ReadonlyArray<AdditionalContentBlock> = [],
  ): SuccessResult<A> => {
    const structuredContent = contract.decodeUnknown(input);

    return {
      structuredContent,
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent),
        },
        ...additionalContent,
      ],
    };
  };
