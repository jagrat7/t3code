// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { DevinSettings } from "@t3tools/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { DevinSkillCatalog, discoverDevinSkills, prepareDevinSkillPrompt } from "./DevinSkills.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const encodeSkills = Schema.encodeSync(DevinSkillCatalog);

const SKILLS_JSON = encodeSkills([
  {
    name: "Visual audit",
    display_name: "Visual check",
    description: "Check a page.",
    base_dir: "/skills/visual-check",
    triggers: ["user"],
    errors: [],
  },
  {
    name: "internal",
    display_name: "internal",
    description: "Internal skill.",
    base_dir: "/skills/internal",
    triggers: ["model"],
    errors: [],
  },
  {
    name: "broken",
    display_name: "broken",
    description: "Invalid skill.",
    base_dir: "/skills/broken",
    triggers: ["user"],
    errors: ["Invalid frontmatter"],
  },
  {
    name: "builtin",
    display_name: "builtin",
    description: "Built-in command.",
    base_dir: "",
    triggers: ["user"],
    errors: [],
  },
]);

const makeDevinCli = Effect.fn("makeDevinCli")(function* (
  skillsJson: string | undefined,
  options?: { fail?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-skills-" });
  const binaryPath = writeFakeCli({
    directory: dir,
    name: "devin",
    source: options?.fail
      ? 'process.stderr.write("boom\\n"); process.exit(2);\n'
      : [
          'if (process.argv[2] === "skills") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds the catalog in stub source.
          `  process.stdout.write(${JSON.stringify(skillsJson ?? "[]")} + "\\n");`,
          "  process.exit(0);",
          "}",
          "process.exit(2);",
          "",
        ].join("\n"),
  });
  return { settings: decodeDevinSettings({ enabled: true, binaryPath }), dir };
});

it.layer(NodeServices.layer)("DevinSkills", (it) => {
  describe("discoverDevinSkills", () => {
    it.effect("maps the CLI catalog onto provider skills with invocation policy", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(SKILLS_JSON);
          const skills = yield* discoverDevinSkills(settings, undefined, dir);
          expect(skills).toEqual([
            {
              name: "broken",
              path: "/skills/broken/SKILL.md",
              enabled: false,
              userInvocable: true,
              userInvocationOnly: true,
              description: "Invalid skill.",
              displayName: "broken",
            },
            {
              name: "internal",
              path: "/skills/internal/SKILL.md",
              enabled: true,
              userInvocable: false,
              userInvocationOnly: false,
              description: "Internal skill.",
              displayName: "internal",
            },
            {
              name: "visual-check",
              path: "/skills/visual-check/SKILL.md",
              enabled: true,
              userInvocable: true,
              userInvocationOnly: true,
              description: "Check a page.",
              displayName: "Visual check",
            },
          ]);
        }),
      ),
    );

    it.effect("fails when the CLI cannot list skills", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(undefined, { fail: true });
          const error = yield* discoverDevinSkills(settings, undefined, dir).pipe(Effect.flip);
          expect(error.message).toContain("could not list skills");
        }),
      ),
    );
  });

  describe("prepareDevinSkillPrompt", () => {
    it.effect("rewrites a $skill mention into a leading slash command with its arguments", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(SKILLS_JSON);
          const prompt = yield* prepareDevinSkillPrompt(
            "please $visual-check the home page",
            settings,
            undefined,
            dir,
          );
          expect(prompt).toBe("/visual-check please  the home page");
        }),
      ),
    );

    it.effect("keeps unknown, model-only, and invalid mentions literal", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(SKILLS_JSON);
          for (const prompt of [
            "check $not-a-skill here",
            "run $internal now",
            "try $broken please",
          ]) {
            expect(yield* prepareDevinSkillPrompt(prompt, settings, undefined, dir)).toBe(prompt);
          }
        }),
      ),
    );

    it.effect("rejects more than one skill mention per message", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(SKILLS_JSON);
          const error = yield* prepareDevinSkillPrompt(
            "$visual-check this then $visual-check that",
            settings,
            undefined,
            dir,
          ).pipe(Effect.flip);
          expect(error.message).toContain("one skill per message");
        }),
      ),
    );

    it.effect("sends the original prompt when discovery fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(undefined, { fail: true });
          const prompt = yield* prepareDevinSkillPrompt(
            "run $anything here",
            settings,
            undefined,
            dir,
          );
          expect(prompt).toBe("run $anything here");
        }),
      ),
    );

    it.effect("leaves prompts without skill mentions untouched", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { settings, dir } = yield* makeDevinCli(SKILLS_JSON);
          expect(yield* prepareDevinSkillPrompt("plain prompt", settings, undefined, dir)).toBe(
            "plain prompt",
          );
        }),
      ),
    );
  });
});
