import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn
        fallbackRedirectUrl="/auth/post-login"
        forceRedirectUrl="/auth/post-login"
      />
    </div>
  );
}
