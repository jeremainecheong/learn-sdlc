# Design: the shelf's contract

Before anyone writes code, write down what the API answers: every operation,
every refusal, and one decision you made about it, in `design/my-design.md`.

## What good looks like

- A table row per operation: the method, the path and what it answers.
- The errors: which status a refusal carries (a book nobody has, a book
  already on loan) and the error code in its body.
- One decision, the alternative you rejected, and the reason, in a sentence
  with *because* in it.

## Using the AI mentor well

Ask the mentor what a client would need to know to call each operation, then
check your table against that list yourself.
