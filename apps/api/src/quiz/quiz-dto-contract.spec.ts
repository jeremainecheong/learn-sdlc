import * as fs from 'fs';
import * as path from 'path';
import type { QuizRoomView as SharedQuizRoomView } from '@learnsdlc/shared';
import type { QuizRoomView } from './quiz.dto';

/**
 * `passCredited` lives in `packages/shared` (`QuizRoomView.passCredited?:
 * true`), so the API needs no local intersection to carry it. One
 * declaration, read by the route and by the quiz room alike.
 */
describe('the quiz room view is the shared declaration, passCredited included', () => {
  it('declares no passCredited of its own, and re-exports the shared view', () => {
    const source = fs.readFileSync(path.join(__dirname, 'quiz.dto.ts'), 'utf8');
    // comments may still name the field; a declaration may not
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/passCredited\??\s*:/);
    expect(code).toMatch(/export type \{[^}]*\bQuizRoomView\b[^}]*\} from '@learnsdlc\/shared'/);

    // and the two names are one type in both directions
    const credited: QuizRoomView['passCredited'] = true;
    const fromShared = (view: SharedQuizRoomView): QuizRoomView => view;
    const toShared = (view: QuizRoomView): SharedQuizRoomView => view;
    expect(credited).toBe(true);
    expect(typeof fromShared).toBe('function');
    expect(typeof toShared).toBe('function');
  });
});
