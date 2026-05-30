import { redirect } from "next/navigation";

// The roadmap is now folded into the Initiatives board (Now / Next / Later
// lives there). Keep this route as a permanent redirect so old links / bookmarks
// don't 404. The customer-facing public roadmap API (/api/v1/roadmap) is
// unchanged.
export default function RoadmapPage() {
  redirect("/initiatives");
}
