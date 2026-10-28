import Link from "next/link";

export default function NotFound() {
  return (
    <div>
      <p className="mb-2">Nothing here.</p>
      <Link href="/" className="underline">
        Back to the board
      </Link>
    </div>
  );
}
