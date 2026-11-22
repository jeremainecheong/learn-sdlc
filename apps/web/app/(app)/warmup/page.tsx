import { redirect } from "next/navigation";

/** /warmup has no page of its own and opens the Implementation guide. */
export default function Page() {
  redirect("/learn/implementation");
}
