import { getProducts } from "@/lib/data";
import { ProductsDataTable } from "./data-table";
import { productsColumns } from "./columns";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Hourglass } from "lucide-react";
import { FetchedAt } from "../fetched-at";

export async function NonCachedSection() {
    const start = performance.now();
    const { products, fetchedAt } = await getProducts();
    const duration = performance.now() - start;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-center gap-2">
                    <Hourglass className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">Without cache</span>
                </div>
                <span className="text-xs text-muted-foreground">
                    hits the database every time
                </span>
            </div>

            <div className="flex items-end justify-between border-y py-4">
                <div>
                    <p className="text-xs text-muted-foreground">Server latency</p>
                    <p className="mt-1 text-3xl font-semibold leading-none tabular-nums">
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
                <CardHeader className="space-y-1">
                    <CardTitle className="text-base">Uncached catalog</CardTitle>
                    <CardDescription className="text-pretty text-sm">
                        Every request re-runs the simulated query — no caching
                        layer involved.
                    </CardDescription>
                </CardHeader>
                <CardContent className="min-w-0">
                    <ProductsDataTable columns={productsColumns} data={products} />
                </CardContent>
            </Card>
        </div>
    );
}
