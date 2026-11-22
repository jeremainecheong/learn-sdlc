import { Injectable } from '@nestjs/common';
import type { LabCohortView, LabView } from '@learnsdlc/shared';
import { AuthUser } from '../auth/auth.decorators';
import { CohortsService } from '../instructor/cohorts.service';
import { formatJoinCode, lanAddresses, resolveLabOrigin } from './lab';
import { qrSvg } from './qr';

/**
 * What the console can tell an instructor about hosting this session.
 *
 * A report, never a control. The API cannot rebind itself and has no route
 * that could: hosting is `npm run host`, and a route that could widen the
 * bind would be a way around `assertBindSafety` from inside the app. All this
 * service does is read the address the API is already reachable on and draw a
 * picture of the join code that already exists.
 */
@Injectable()
export class LabService {
  /**
   * QR codes by the text they encode. A class list is re-read on every console
   * load and encoding the same three strings each time is waste; the cache is
   * dropped whole whenever the origin changes, which is the only thing that
   * can make an entry wrong.
   */
  private qrCache = new Map<string, string>();
  private cachedOrigin: string | null = null;

  constructor(private readonly cohorts: CohortsService) {}

  async lab(caller: AuthUser): Promise<LabView> {
    const { hosted, origin, reason } = resolveLabOrigin(process.env, lanAddresses());
    if (origin !== this.cachedOrigin) {
      this.qrCache = new Map();
      this.cachedOrigin = origin;
    }

    const owned = await this.cohorts.listOwned(caller.id);
    const rows: LabCohortView[] = [];
    for (const cohort of owned) {
      const joinCode = formatJoinCode(cohort.joinCode);
      const joinUrl = origin ? `${origin}/join?code=${joinCode}` : '';
      rows.push({
        cohortId: cohort.id,
        name: cohort.name,
        joinCode,
        joinUrl,
        qrSvg: joinUrl ? await this.encode(joinUrl) : null,
      });
    }

    return { hosted, origin, unreachable: reason, cohorts: rows };
  }

  private async encode(text: string): Promise<string> {
    const cached = this.qrCache.get(text);
    if (cached) return cached;
    const svg = await qrSvg(text);
    this.qrCache.set(text, svg);
    return svg;
  }
}
