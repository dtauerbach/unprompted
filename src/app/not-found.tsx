import Link from "next/link";

export default function NotFound() {
  return (
    <div>
      <p className="mb-2">Nothing here.</p>
      <Link href="/forum" className="underline">
        Back to the forum
      </Link>
    </div>
  );
}
