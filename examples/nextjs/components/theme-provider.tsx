"use client";

import * as React from "react";
import {
    ThemeProvider as NextThemesProvider,
    useTheme,
    type ThemeProviderProps,
} from "next-themes";

type Props = ThemeProviderProps & {
    children?: React.ReactNode;
};

const ThemesProvider = NextThemesProvider as React.ComponentType<Props>;

function ThemeProvider({ children, ...props }: Props) {
    return (
        <ThemesProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            {...props}
        >
            <ThemeHotkey />
            {children}
        </ThemesProvider>
    );
}

function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
    );
}

function ThemeHotkey() {
    const { resolvedTheme, setTheme } = useTheme();

    React.useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.defaultPrevented || event.repeat) {
                return;
            }

            if (event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }

            if (!event.key || event.key.toLowerCase() !== "d") {
                return;
            }

            if (isTypingTarget(event.target)) {
                return;
            }

            setTheme(resolvedTheme === "dark" ? "light" : "dark");
        }

        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [resolvedTheme, setTheme]);

    return null;
}

export { ThemeProvider };
