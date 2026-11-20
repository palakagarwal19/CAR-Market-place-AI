"use client";

import { signOut } from "next-auth/react";

export function SignOutButton({ children, className }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => signOut({ redirectTo: "/" })}
    >
      {children}
    </button>
  );
}
