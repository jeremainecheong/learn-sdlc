import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { repoArchiveName } from '@learnsdlc/shared';
import { AuthUser, CurrentUser } from '../auth/auth.decorators';
import { RateLimit, RateLimitGuard } from '../auth/rate-limit.guard';
import { RepoService } from './repo.service';

/**
 * The learner's own project as a git repository.
 *
 * Both routes act only on the caller's own enrolment: there is deliberately
 * no path parameter naming another learner, the same rule
 * `AccountController` states. There is no instructor-facing export.
 */
@Controller('repo')
@UseGuards(RateLimitGuard)
export class RepoController {
  constructor(private readonly repo: RepoService) {}

  /**
   * The counts the card shows. Cheap: a handful of counting queries and no
   * file content at all, so it sits at Run's cadence and a page can ask for
   * it again after a submission without thinking about it.
   */
  @RateLimit(30, 60)
  @Get(':slug/summary')
  summary(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.repo.summary(user.id, slug);
  }

  /**
   * The archive. Three a minute, matching the class export and for the same
   * stated reason: it reads every row the caller owns.
   *
   * `@Res()` without `passthrough` on purpose. Nest stops managing the
   * response, which is what lets the service write entry by entry instead of
   * concatenating a term of work into one buffer, and it is why the service
   * refuses over the ceiling before the first byte rather than half way
   * through, since an exception filter cannot set a status on a response that
   * has already begun.
   */
  @RateLimit(3, 60)
  @Get(':slug/export.zip')
  async export(
    @CurrentUser() user: AuthUser,
    @Param('slug') slug: string,
    @Res() res: Response,
  ): Promise<void> {
    // A slow client throttles the writer instead of filling the process's
    // memory: every write that says "not now" is waited on.
    const write = (chunk: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        if (res.destroyed) {
          reject(new Error('the client went away'));
          return;
        }
        if (res.write(chunk)) {
          resolve();
          return;
        }
        res.once('drain', resolve);
        res.once('error', reject);
      });

    let started = false;
    // Every header is set here, before the service writes anything: once a
    // byte is out there is no status and no header left to set.
    const begin = (info: { commits: number; tags: number }): void => {
      started = true;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="${repoArchiveName(slug)}"`);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-repo-commits', String(info.commits));
      res.setHeader('x-repo-tags', String(info.tags));
    };

    try {
      await this.repo.export(user.id, slug, write, begin);
      res.end();
    } catch (error) {
      // Before a byte: the ordinary refusal, with the API's own sentence.
      // After one: there is no status left to set, so the truncated body is
      // destroyed rather than completed, and the client sees a broken
      // download instead of a repository that is quietly missing objects.
      if (started) {
        res.destroy();
        return;
      }
      throw error;
    }
  }
}
