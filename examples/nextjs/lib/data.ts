"use server";

import products from "@/data/products.json";
import { Product } from "./types";
import { cacheLife, cacheTag, updateTag } from "next/cache";
import { connection } from "next/server";

const SLOW_DB_MS = 1000;

const getCachedProducts = async () => {
    "use cache";
    cacheTag("products");
    await new Promise((resolve) => setTimeout(resolve, SLOW_DB_MS));

    return {
        products: products as Product[],
        fetchedAt: new Date().toISOString(),
    };
};

const getProducts = async () => {
    await connection();
    const currentTime = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, SLOW_DB_MS));
    return {
        products: products as Product[],
        fetchedAt: currentTime,
    };
};

const revalidateProducts = async () => {
    updateTag("products");
};

export { getProducts, getCachedProducts, revalidateProducts };
