<script setup lang="ts">
import primitiveLogoIcon from "@/assets/primitive-logo.png";
import Autoplay from "embla-carousel-autoplay";
import { Activity, PieChart, TrendingDown } from "@lucide/vue";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import PrimitiveLogin from "@/components/auth/PrimitiveLogin.vue";
import { config } from "@/config/envConfig";
import { defineComponent, h, type Component } from "vue";

// App icon component - uses size-full to fill parent container
const AppIcon = defineComponent({
  name: "AppIcon",
  setup() {
    return () =>
      h("img", {
        src: primitiveLogoIcon,
        alt: "App Icon",
        class: "size-full",
      });
  },
});

const Feature1Content = defineComponent({
  name: "Feature1Content",
  setup() {
    return () =>
      h(
        "div",
        {
          class:
            "w-full max-w-4xl h-96 bg-gradient-to-br from-blue-50 to-indigo-100 rounded-lg shadow-lg flex items-center justify-center",
        },
        [
          h("div", { class: "text-center" }, [
            h(
              "div",
              {
                class:
                  "w-24 h-24 rounded-full bg-gradient-to-br from-blue-200 to-indigo-300 mx-auto mb-3 flex items-center justify-center",
              },
              [h(PieChart, { class: "h-8 w-8 text-blue-600" })]
            ),
            h(
              "p",
              { class: "text-sm text-muted-foreground" },
              "Feature 1 Screenshot"
            ),
          ]),
        ]
      );
  },
});

const Feature2Content = defineComponent({
  name: "Feature2Content",
  setup() {
    return () =>
      h(
        "div",
        {
          class:
            "w-full max-w-4xl h-96 bg-gradient-to-br from-purple-50 to-violet-100 rounded-lg shadow-lg flex items-center justify-center",
        },
        [
          h("div", { class: "text-center" }, [
            h(
              "div",
              {
                class:
                  "w-24 h-24 rounded-full bg-gradient-to-br from-purple-200 to-violet-300 mx-auto mb-3 flex items-center justify-center",
              },
              [h(TrendingDown, { class: "h-8 w-8 text-purple-600" })]
            ),
            h(
              "p",
              { class: "text-sm text-muted-foreground" },
              "Feature 2 Screenshot"
            ),
          ]),
        ]
      );
  },
});

interface CarouselItemData {
  icon?: Component;
  title: string;
  description: string;
  content?: Component;
}

const carouselItems: CarouselItemData[] = [
  {
    icon: PieChart as unknown as Component,
    title: "Feature 1",
    description: "Lorum ipsum dolor sit amet, consectetur adipiscing elit.",
    content: Feature1Content,
  },
  {
    icon: TrendingDown as unknown as Component,
    title: "Feature 2",
    description: "Lorum ipsum dolor sit amet, consectetur adipiscing elit.",
    content: Feature2Content,
  },
];

const autoplayPlugin = Autoplay({
  delay: 5000,
  stopOnInteraction: true,
});
</script>

<template>
  <div class="fixed inset-0 overflow-hidden flex flex-col lg:flex-row">
    <!-- Login form section -->
    <aside class="w-full lg:basis-5/12">
      <PrimitiveLogin
        :appName="config.appName"
        defaultContinueRoute="home"
        onboardingRoute="onboarding"
      >
        <template #header>
          <div class="flex justify-center gap-2 lg:justify-start">
            <a href="#" class="flex items-center gap-2 font-medium">
              <div
                class="flex aspect-square size-8 items-center justify-center rounded-lg border"
              >
                <AppIcon class="size-6" />
              </div>
              {{ config.appName }}
            </a>
          </div>
        </template>
      </PrimitiveLogin>
    </aside>

    <!-- Marketing carousel section -->
    <section
      v-if="carouselItems.length > 0"
      class="hidden lg:flex flex-1 min-w-0 flex-col bg-muted"
    >
      <Carousel
        class="flex flex-col h-full"
        :opts="{ loop: true, align: 'start' }"
        :plugins="[autoplayPlugin]"
        v-slot="{ scrollNext }"
      >
        <div class="cursor-pointer h-full" @click="scrollNext">
          <CarouselContent class="w-full h-full">
            <CarouselItem
              v-for="(item, index) in carouselItems"
              :key="index"
              class="h-full"
            >
              <div
                class="flex flex-col items-center justify-center h-full p-6 text-center"
              >
                <div class="mb-4">
                  <component
                    :is="item.icon || Activity"
                    class="h-12 w-12 text-primary mx-auto mb-3"
                  />
                  <h2 class="text-xl font-bold mb-2">{{ item.title }}</h2>
                  <p class="text-muted-foreground mb-4 text-sm">
                    {{ item.description }}
                  </p>
                </div>
                <component v-if="item.content" :is="item.content" />
              </div>
            </CarouselItem>
          </CarouselContent>
        </div>
      </Carousel>
    </section>
  </div>
</template>
