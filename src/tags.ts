export type Tags = string[][];

/** The value of the first tag called `name`, or undefined if there is none. */
export function tagValue(tags: Tags, name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}
