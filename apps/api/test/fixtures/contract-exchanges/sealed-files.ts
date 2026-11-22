/**
 * The bytes the sealed recording was made with, by the
 * name the recording holds them under (`<sealed:NAME>`).
 *
 * The recording never holds sealed bytes. The API spec
 * (`sealed-contract-wiring.e2e-spec.ts`) seals these through `sealed.write`;
 * the web test (`apps/web/test/sealed-upload-wiring.test.tsx`) hands the page
 * the same bytes as the chosen file and checks the page sent exactly these.
 */
export const CONTRACT_SEALED_MARKER = 'WIRE-X-SEALED-EXTRA-7Q4P';

export const CONTRACT_SEALED_FILES = {
  /** A further hidden test for the implementation task's first run. */
  'hidden-extra': () =>
    Buffer.from(
      `# ${CONTRACT_SEALED_MARKER}\n# A hidden test the teacher adds in the editor.\n\ndef test_wire_x_extra_hidden_case():\n    assert sorted(["b", "a"]) == ["a", "b"]\n`,
      'utf-8',
    ),
  /** A further hidden test for the implementation task's second run (the multi-run seal). */
  'hidden-extra-web': () =>
    Buffer.from(
      `// ${CONTRACT_SEALED_MARKER}-WEB\n// A hidden test the teacher adds to the second run.\nimport { expect, test } from 'vitest';\n\ntest('wire-x extra hidden case', () => {\n  expect(['b', 'a'].sort()).toEqual(['a', 'b']);\n});\n`,
      'utf-8',
    ),
} as const;
