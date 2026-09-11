"use client";

import { createColumnHelper } from "@tanstack/react-table";
import { type ProductsDataTableFeatures } from "./data-table-features";
import { Product } from "@/lib/types";

const columnHelper = createColumnHelper<ProductsDataTableFeatures, Product>();

export const productsColumns = columnHelper.columns([
    columnHelper.accessor("name", {
        header: "Name",
    }),
    columnHelper.accessor("price", {
        header: "Price",
    }),
    columnHelper.accessor("stock", {
        header: "Stock",
    }),
]);
