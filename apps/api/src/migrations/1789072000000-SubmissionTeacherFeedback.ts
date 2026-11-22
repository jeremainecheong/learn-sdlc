import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class SubmissionTeacherFeedback1789072000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    const postgres = queryRunner.connection.options.type === 'postgres';
    await queryRunner.createTable(
      new Table({
        name: 'submission_teacher_feedback',
        columns: [
          {
            name: 'id',
            type: postgres ? 'uuid' : 'varchar',
            isPrimary: true,
            ...(postgres ? { default: 'uuid_generate_v4()' } : {}),
          },
          ...[
            'submissionId',
            'phaseStateId',
            'userId',
            'cohortId',
            'authorUserId',
            'authorName',
            'requestId',
            'action',
          ].map((name) => ({ name, type: 'varchar' })),
          { name: 'text', type: 'text' },
          {
            name: 'createdAt',
            type: postgres ? 'timestamp' : 'datetime',
            default: postgres ? 'now()' : "datetime('now')",
          },
        ],
      }),
    );
    await queryRunner.createIndices('submission_teacher_feedback', [
      new TableIndex({
        name: 'IDX_submission_teacher_feedback_submission',
        columnNames: ['submissionId', 'createdAt'],
      }),
      new TableIndex({
        name: 'IDX_submission_teacher_feedback_user',
        columnNames: ['userId'],
      }),
      new TableIndex({
        name: 'UQ_submission_teacher_feedback_request',
        columnNames: ['authorUserId', 'requestId'],
        isUnique: true,
      }),
    ]);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('submission_teacher_feedback');
  }
}
