import { Suspense } from "react";
import { ProductsSection } from "@/components/products/cachedSection";
import { ProductsLoading } from "@/components/products/loading";
import { NonCachedSection } from "@/components/products/nonCachedSection";

export default function DemoPage() {
    return (
        <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8 lg:py-20">
            <div className="mb-10 max-w-2xl space-y-3 sm:mb-14">
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                    Cache Components Demo
                </h1>
                <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                    Two panels fetch the same catalog from a simulated 1-second
                    database. The left one is wrapped in{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
                        &quot;use cache&quot;
                    </code>
                    ; the right one isn&apos;t. Refresh the page to watch the gap.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-10">
                <section className="min-w-0">
                    <Suspense fallback={<ProductsLoading />}>
                        <ProductsSection />
                    </Suspense>
                </section>

                <section className="min-w-0 lg:border-l lg:pl-10">
                    <Suspense fallback={<ProductsLoading />}>
                        <NonCachedSection />
                    </Suspense>
                </section>
            </div>
        </main>
    );
}
