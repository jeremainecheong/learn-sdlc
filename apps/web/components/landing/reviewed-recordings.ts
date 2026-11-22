import type { RecordedWalkthrough } from './RecordedWalkthroughs';

/**
 * The reviewed starter tutorials: one recorded walkthrough per phase, each
 * with its title, caption, video, poster, captions file and the `review`
 * record that cleared it for the public tour.
 */
export const REVIEWED_WALKTHROUGHS: readonly RecordedWalkthrough[] = [
  {
    "phase": "requirements",
    "title": "Requirements",
    "caption": "Start with the stakeholder interview, then connect epics, stories and acceptance criteria.",
    "edition": "phase-tutorials-v2",
    "kind": "workspace-tutorial",
    "src": "/walkthroughs/phase-tutorials-v2/requirements.mp4",
    "poster": "/walkthroughs/phase-tutorials-v2/requirements.webp",
    "captionsSrc": "/walkthroughs/phase-tutorials-v2/requirements.vtt",
    "review": {
      "audience": "public-product-tour",
      "reviewedAt": "2026-09-15T15:17:57.199541+00:00",
      "sourceVerificationAt": "2026-09-15T14:35:09.660000+00:00",
      "solutionsExcluded": true,
      "privateConversationsExcluded": true
    }
  },
  {
    "phase": "design",
    "title": "Design",
    "caption": "Find the API contracts and diagram tools, then learn where to review and submit your design.",
    "edition": "phase-tutorials-v2",
    "kind": "workspace-tutorial",
    "src": "/walkthroughs/phase-tutorials-v2/design.mp4",
    "poster": "/walkthroughs/phase-tutorials-v2/design.webp",
    "captionsSrc": "/walkthroughs/phase-tutorials-v2/design.vtt",
    "review": {
      "audience": "public-product-tour",
      "reviewedAt": "2026-09-15T15:17:57.207733+00:00",
      "sourceVerificationAt": "2026-09-15T14:36:39.748000+00:00",
      "solutionsExcluded": true,
      "privateConversationsExcluded": true
    }
  },
  {
    "phase": "implementation",
    "title": "Implementation",
    "caption": "Find your code, checks and preview controls. Live preview was disabled in this local recording.",
    "edition": "phase-tutorials-v2",
    "kind": "workspace-tutorial",
    "src": "/walkthroughs/phase-tutorials-v2/implementation.mp4",
    "poster": "/walkthroughs/phase-tutorials-v2/implementation.webp",
    "captionsSrc": "/walkthroughs/phase-tutorials-v2/implementation.vtt",
    "review": {
      "audience": "public-product-tour",
      "reviewedAt": "2026-09-15T15:17:57.213979+00:00",
      "sourceVerificationAt": "2026-09-15T14:37:23.227000+00:00",
      "solutionsExcluded": true,
      "privateConversationsExcluded": true
    }
  },
  {
    "phase": "testing",
    "title": "Testing",
    "caption": "Find test files, run controls and execution evidence before submitting your testing work.",
    "edition": "phase-tutorials-v2",
    "kind": "workspace-tutorial",
    "src": "/walkthroughs/phase-tutorials-v2/testing.mp4",
    "poster": "/walkthroughs/phase-tutorials-v2/testing.webp",
    "captionsSrc": "/walkthroughs/phase-tutorials-v2/testing.vtt",
    "review": {
      "audience": "public-product-tour",
      "reviewedAt": "2026-09-15T15:19:20.695583+00:00",
      "sourceVerificationAt": "2026-09-15T14:38:08.573000+00:00",
      "solutionsExcluded": true,
      "privateConversationsExcluded": true
    }
  },
  {
    "phase": "deployment",
    "title": "Deployment",
    "caption": "Find configuration, selfcheck output and the incident drill. The selfcheck does not run Docker builds or GitHub Actions.",
    "edition": "phase-tutorials-v2",
    "kind": "workspace-tutorial",
    "src": "/walkthroughs/phase-tutorials-v2/deployment.mp4",
    "poster": "/walkthroughs/phase-tutorials-v2/deployment.webp",
    "captionsSrc": "/walkthroughs/phase-tutorials-v2/deployment.vtt",
    "review": {
      "audience": "public-product-tour",
      "reviewedAt": "2026-09-15T15:28:14.827630+00:00",
      "sourceVerificationAt": "2026-09-15T14:39:02.753000+00:00",
      "solutionsExcluded": true,
      "privateConversationsExcluded": true
    }
  },
  {
    "phase": "maintenance",
    "title": "Maintenance",
    "caption": "Follow the change request through edits, regression evidence and pull-request review.",
    "edition": "phase-tutorials-v2",
    "kind": "workspace-tutorial",
    "src": "/walkthroughs/phase-tutorials-v2/maintenance.mp4",
    "poster": "/walkthroughs/phase-tutorials-v2/maintenance.webp",
    "captionsSrc": "/walkthroughs/phase-tutorials-v2/maintenance.vtt",
    "review": {
      "audience": "public-product-tour",
      "reviewedAt": "2026-09-15T15:28:14.830205+00:00",
      "sourceVerificationAt": "2026-09-15T14:49:54.495000+00:00",
      "solutionsExcluded": true,
      "privateConversationsExcluded": true
    }
  }
];
