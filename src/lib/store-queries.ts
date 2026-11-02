import { queryOptions } from '@tanstack/react-query';
import { getCatalogue, getDeliveryOptions } from './catalogue.functions';
export const catalogueOptions = queryOptions({ queryKey: ['public-catalogue'], queryFn: () => getCatalogue(), staleTime: 30_000 });
export const deliveryOptions = queryOptions({ queryKey: ['public-delivery-options'], queryFn: () => getDeliveryOptions(), staleTime: 30_000 });