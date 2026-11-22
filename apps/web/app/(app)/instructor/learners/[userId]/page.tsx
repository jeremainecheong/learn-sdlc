import { redirect } from "next/navigation";
export default async function LearnerDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  redirect(`/teacher?learner=${encodeURIComponent(userId)}`);
}
