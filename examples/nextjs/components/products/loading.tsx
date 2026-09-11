import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export function ProductsLoading() {

    return (
        <div className="flex flex-col gap-5 h-full">
            <div className="flex items-center justify-between pb-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-24" />
            </div>

            <div className="flex items-end justify-between border-y py-4">
                <div className="space-y-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-8 w-16" />
                </div>
                <div className="flex gap-6">
                    <div className="space-y-2 text-right">
                        <Skeleton className="ml-auto h-3 w-14" />
                        <Skeleton className="ml-auto h-4 w-16" />
                    </div>
                    <div className="space-y-2 text-right">
                        <Skeleton className="ml-auto h-3 w-14" />
                        <Skeleton className="ml-auto h-4 w-10" />
                    </div>
                </div>
            </div>

            <Card className="shadow-none h-full">
                <CardHeader className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-full max-w-sm" />
                </CardHeader>
                <CardContent>
                    <div className="overflow-hidden rounded-md border">
                        <div className="bg-muted px-6 py-3">
                            <div className="flex gap-6">
                                <Skeleton className="h-4 w-20" />
                                <Skeleton className="h-4 w-16" />
                                <Skeleton className="h-4 w-14" />
                            </div>
                        </div>
                        {[...Array(5)].map((_, i) => (
                            <div
                                key={i}
                                className={
                                    i % 2
                                        ? "flex gap-6 bg-muted/40 px-6 py-4"
                                        : "flex gap-6 px-6 py-4"
                                }
                            >
                                <Skeleton className="h-4 w-28" />
                                <Skeleton className="h-4 w-12" />
                                <Skeleton className="h-4 w-10" />
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}