/** The command-line options every command shares a parser for. */
export interface CliArgs {
  positional: string[];
  /** `--pilot N`; `--pilot` alone is "default", meaning `cfg.pilotSize`. */
  pilot?: number | "default";
  /** `--relays a,b` */
  relays?: string[];
  /** `--auto`: an unattended run, which reads an `ncryptsec` passphrase from a file. */
  auto?: true;
  /** `--first-run`: lets `build` run on a state that holds no items. */
  firstRun?: true;
}

/** The option names present in `args`, for a command to refuse the ones it does not take. */
export function givenOptions(args: CliArgs): string[] {
  const given: string[] = [];
  if (args.pilot !== undefined) given.push("--pilot");
  if (args.relays !== undefined) given.push("--relays");
  if (args.auto) given.push("--auto");
  if (args.firstRun) given.push("--first-run");
  return given;
}

/**
 * Parses `--pilot [N]`, `--relays a,b`, `--auto` and `--first-run`.
 * Anything else starting with `-` is refused; the rest is positional.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--pilot": {
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          const n = Number(next);
          if (n < 1) throw new Error("--pilot needs a size of at least 1");
          args.pilot = n;
          i++;
        } else {
          args.pilot = "default";
        }
        break;
      }
      case "--relays": {
        const names = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (names.length === 0) throw new Error("--relays needs names, e.g. --relays dcosl,search");
        args.relays = names;
        break;
      }
      case "--auto":
        args.auto = true;
        break;
      case "--first-run":
        args.firstRun = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        args.positional.push(arg);
    }
  }
  return args;
}
