"use client";

import { useTable, type ColumnDef, type RowData } from "@tanstack/react-table";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";

import {
    productsDataTableFeatures,
    type ProductsDataTableFeatures,
} from "./data-table-features";

interface ProductsDataTableProps<TData extends RowData> {
    columns: ColumnDef<ProductsDataTableFeatures, TData>[];
    data: TData[];
}

export function ProductsDataTable<TData extends RowData>({
    columns,
    data,
}: ProductsDataTableProps<TData>) {
    const table = useTable({
        features: productsDataTableFeatures,
        data,
        columns,
    });

    return (
        <div className="w-full overflow-x-auto rounded-md border">
            <Table className="min-w-[280px]">
                <TableHeader className="bg-muted">
                    {table.getHeaderGroups().map((headerGroup) => (
                        <TableRow key={headerGroup.id}>
                            {headerGroup.headers.map((header) => {
                                return (
                                    <TableHead key={header.id}>
                                        {header.isPlaceholder ? null : (
                                            <table.FlexRender header={header} />
                                        )}
                                    </TableHead>
                                );
                            })}
                        </TableRow>
                    ))}
                </TableHeader>
                <TableBody>
                    {table.getRowModel().rows?.length ? (
                        table.getRowModel().rows.map((row) => (
                            <TableRow
                                key={row.id}
                                data-state={row.getIsSelected() && "selected"}
                                className="h-12"
                            >
                                {row.getVisibleCells().map((cell) => (
                                    <TableCell key={cell.id}>
                                        <table.FlexRender cell={cell} />
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))
                    ) : (
                        <TableRow>
                            <TableCell
                                colSpan={columns.length}
                                className="h-24 text-center"
                            >
                                No results.
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
        </div>
    );
}
