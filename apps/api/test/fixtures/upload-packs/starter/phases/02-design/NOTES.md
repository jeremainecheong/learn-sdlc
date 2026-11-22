# Notes for the Design phase

The room opens on the Design forms. The learner adds the shelf's entities, an
operation for each thing a story needs, the endpoints with each refusal's
status and error code, and a decision with its reason.

The floor is the counts in `checks.floor`: one entity, three operations, four
endpoints with an error catalogue, one decision, and every listed story served.
The AI reviewer marks the rest against the rubric.

The sequence diagram is switched off (`"sequence": false`), because the shelf's
stories need no request path. Switching it on adds a Sequence diagram tab and
one floor line that asks the diagram to name one of the learner's operations.

Nothing runs here, so the phase costs no microVMs. There is no sealed file in
this phase.
