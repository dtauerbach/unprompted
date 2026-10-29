import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

// Draws nothing of its own: a layout also wraps the "not found" a non-admin
// gets, so the menu (src/app/admin/nav.tsx) is on each page, after its check.
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
