import { getCachedProducts, revalidateProducts } from "@/lib/data";
import { ProductsDataTable } from "./data-table";
import { productsColumns } from "./columns";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { RefreshCcw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { FetchedAt } from "../fetched-at";

export async function ProductsSection() {
    const start = performance.now();
    const { products, fetchedAt } = await getCachedProducts();
    const duration = performance.now() - start;
    const isHit = duration < 200;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-center gap-2">
                    <Zap
                        className={cn(
                            "size-4",
                            isHit
                                ? "text-primary"
                                : "text-muted-foreground",
                        )}
                    />
                    <span className="text-sm font-medium">With TriCache</span>
                </div>
                <span className="text-xs text-muted-foreground">
                    {isHit ? "served from cache" : "cache warming up"}
                </span>
            </div>

            <div className="flex items-end justify-between border-y py-4">
                <div>
                    <p className="text-xs text-muted-foreground">Server latency</p>
                    <p
                        className={cn(
                            "mt-1 text-3xl font-semibold leading-none tabular-nums",
                            isHit
                                ? "text-primary"
                                : "text-foreground",
                        )}
                    >
                        {duration.toFixed(0)}
                        <span className="ml-0.5 text-base font-normal text-muted-foreground">
                            ms
                        </span>
                    </p>
                </div>
                <div className="flex gap-6 text-right">
                    <div>
                        <p className="text-xs text-muted-foreground">Fetched</p>
                        <p className="mt-1 text-sm tabular-nums">
                            <FetchedAt date={fetchedAt} />
                        </p>
                    </div>
                    <div>
                        <p className="text-xs text-muted-foreground">Products</p>
                        <p className="mt-1 text-sm tabular-nums">{products.length}</p>
                    </div>
                </div>
            </div>

            <Card className="shadow-none">
                <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
                    <div className="min-w-0 space-y-1">
                        <CardTitle className="text-base">Cached catalog</CardTitle>
                        <CardDescription className="text-pretty text-sm">
                            First load runs a 1s simulated query. Refresh the
                            page — later loads return instantly.
                        </CardDescription>
                    </div>
                    <form action={revalidateProducts} className="shrink-0">
                        <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 px-2"
                        >
                            <RefreshCcw className="size-3.5" />
                            Revalidate
                        </Button>
                    </form>
                </CardHeader>
                <CardContent className="min-w-0">
                    <ProductsDataTable columns={productsColumns} data={products} />
                </CardContent>
            </Card>
        </div>
    );
}
