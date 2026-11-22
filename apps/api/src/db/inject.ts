import { Inject } from '@nestjs/common';

/** DI token for an entity's repository (thin stand-in for @nestjs/typeorm). */
export const repoToken = (entity: { name: string }) => `REPOSITORY_${entity.name}`;

export const InjectRepository = (entity: { name: string }) => Inject(repoToken(entity));
