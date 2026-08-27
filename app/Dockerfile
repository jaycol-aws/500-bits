# Multi-stage build -> distroless static final image.
FROM golang:1.22 AS build
WORKDIR /src
ENV GOPROXY=direct GOFLAGS=-mod=mod
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/checkout-service .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/checkout-service /checkout-service
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/checkout-service"]
