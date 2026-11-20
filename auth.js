import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { timingSafeEqual } from "node:crypto";

function matchesDemoPassword(value, expected) {
  const provided = Buffer.from(value);
  const configured = Buffer.from(expected);
  return (
    provided.length === configured.length &&
    timingSafeEqual(provided, configured)
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Demo email", type: "email" },
        password: { label: "Demo password", type: "password" },
      },
      async authorize(credentials) {
        const demoEmail = process.env.DEMO_LOGIN_EMAIL?.trim().toLowerCase();
        const demoPassword = process.env.DEMO_LOGIN_PASSWORD;
        if (!demoEmail || !demoPassword) {
          throw new Error("Demo login credentials are not configured.");
        }

        const email =
          typeof credentials?.email === "string"
            ? credentials.email.trim().toLowerCase()
            : "";
        const password =
          typeof credentials?.password === "string"
            ? credentials.password
            : "";
        if (
          email !== demoEmail ||
          password.length > 256 ||
          !matchesDemoPassword(password, demoPassword)
        ) {
          return null;
        }

        return {
          id: `demo:${demoEmail}`,
          email: demoEmail,
          name: "Course Project Demo",
          emailVerified: true,
        };
      },
    }),
  ],
  pages: {
    signIn: "/sign-in",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.email = user.email;
        token.name = user.name;
        token.emailVerified = user.emailVerified === true;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub;
        session.user.email = token.email;
        session.user.name = token.name;
        session.user.emailVerified = token.emailVerified === true;
      }

      return session;
    },
  },
});
