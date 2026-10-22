import { Nav } from "./sections/nav.tsx"
import { Hero } from "./sections/hero.tsx"
import { LogoCloud } from "./sections/logo-cloud.tsx"
import { HowItWorks } from "./sections/how-it-works.tsx"
import { CodeShowcase } from "./sections/code-showcase.tsx"
import { Deploy } from "./sections/deploy.tsx"
import { Features } from "./sections/features.tsx"
import { Security } from "./sections/security.tsx"
import { GetStarted } from "./sections/get-started.tsx"
import { Footer } from "./sections/footer.tsx"

export default function App() {
  return (
    <div id="top" className="dark min-h-screen bg-black text-neutral-100">
      <Nav />
      <main>
        <Hero />
        <LogoCloud />
        <HowItWorks />
        <CodeShowcase />
        <Deploy />
        <Features />
        <Security />
        <GetStarted />
      </main>
      <Footer />
    </div>
  )
}
